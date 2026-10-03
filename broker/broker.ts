// foxwire broker: owns the loopback WebSocket the extension dials into, and multiplexes any number of
// mcp clients (Unix socket, newline-delimited JSON frames) onto that one extension connection.
// docs/DESIGN.md §2–§4. Zero state beyond pending requests; safe to kill at any time.
import fs from "node:fs";
import net from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  fwError,
  isEvent,
  isRequest,
  isResponse,
  parseFrame,
  type AuthParams,
  type BrokerStatus,
  type EventFrame,
  type ExtStatus,
  type Frame,
  type FwError,
  type RequestFrame,
  type ResponseFrame,
} from "../shared/protocol.ts";
import { hexEqual, hmacHex, randomHex } from "../shared/hmac.ts";
import { announceSecret, loadOrCreateSecret } from "./pairing.ts";
import { logPath, port as cfgPort, secretPath, socketPath } from "./paths.ts";

const AUTH_WINDOW_MS = 5_000;
const PING_INTERVAL_MS = 30_000;
const GRACE_MS = 5_000; // broker-side ceiling = call timeout + grace; the extension enforces the real one

const log = (...a: unknown[]) => process.stderr.write(`${new Date().toISOString()} ${a.map(String).join(" ")}\n`);

interface Client {
  id: number;
  sock: net.Socket;
  buf: string;
  connectedAt: string;
  pending: Set<number>;
}
interface Pending {
  client: Client;
  clientReqId: number;
  timer: NodeJS.Timeout;
}
interface Ext {
  ws: WebSocket;
  info: ExtStatus;
  connectedAt: string;
  alive: boolean;
}

class Broker {
  private clients = new Map<number, Client>();
  private nextClientId = 1;
  private pending = new Map<number, Pending>();
  private nextReqId = 1;
  private ext: Ext | null = null;

  private secret: string;
  private port: number;
  private sockPath: string;
  constructor(secret: string, port: number, sockPath: string) {
    this.secret = secret;
    this.port = port;
    this.sockPath = sockPath;
  }

  // ---- extension side -----------------------------------------------------------------------
  startWs(): WebSocketServer {
    const wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.port,
      verifyClient: ({ origin }: { origin: string }) => typeof origin === "string" && origin.startsWith("moz-extension://"),
    });
    wss.on("connection", (ws) => this.handshake(ws).catch((e) => log("handshake error:", e)));
    wss.on("error", (e) => log("ws server error:", e));
    setInterval(() => {
      const ext = this.ext;
      if (!ext) return;
      if (!ext.alive) return ext.ws.terminate();
      ext.alive = false;
      ext.ws.ping();
    }, PING_INTERVAL_MS).unref();
    return wss;
  }

  private async handshake(ws: WebSocket): Promise<void> {
    const nonce = randomHex(32);
    const expected = await hmacHex(this.secret, nonce);
    const authed = await new Promise<AuthParams | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), AUTH_WINDOW_MS);
      ws.once("message", (data) => {
        clearTimeout(timer);
        const f = parseFrame(data.toString());
        if (!f || !isEvent(f) || f.event !== "auth") return resolve(null);
        const p = f.params as Partial<AuthParams> | undefined;
        if (!p || typeof p.hmac !== "string" || !hexEqual(p.hmac, expected)) return resolve(null);
        resolve({ hmac: p.hmac, extensionVersion: String(p.extensionVersion ?? "?"), firefoxVersion: String(p.firefoxVersion ?? "?") });
      });
      ws.once("close", () => resolve(null));
      ws.send(JSON.stringify({ event: "hello", params: { nonce, protocol: PROTOCOL_VERSION } } satisfies EventFrame));
    });
    if (!authed) {
      log("extension connection rejected (bad or missing auth)");
      ws.close(4001, "auth failed");
      return;
    }
    if (this.ext) {
      log("replacing previous extension connection");
      this.ext.ws.close(4002, "superseded");
      this.ext = null;
    }
    const ext: Ext = {
      ws,
      connectedAt: new Date().toISOString(),
      alive: true,
      info: { extensionVersion: authed.extensionVersion, firefoxVersion: authed.firefoxVersion, grants: [], evaluateEnabled: false, bubbleEnabled: true },
    };
    this.ext = ext;
    ws.on("pong", () => (ext.alive = true));
    ws.on("message", (data) => this.fromExt(parseFrame(data.toString())));
    ws.on("close", (code, reason) => {
      if (this.ext !== ext) return;
      this.ext = null;
      log(`extension disconnected (${code} ${reason.toString()})`);
      this.failAllPending(fwError("NOT_PAIRED", "extension disconnected mid-call"));
      this.broadcast({ event: "ext.disconnected", params: { reason: `${code} ${reason.toString()}` } });
    });
    ws.on("error", (e) => log("extension socket error:", e));
    ws.send(JSON.stringify({ event: "paired" } satisfies EventFrame));
    log(`extension paired: v${authed.extensionVersion} on Firefox ${authed.firefoxVersion}`);
    this.broadcast({ event: "ext.connected", params: { ...ext.info } });
  }

  private fromExt(f: Frame | null): void {
    if (!f) return;
    if (isResponse(f)) {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      p.client.pending.delete(f.id);
      this.reply(p.client, { id: p.clientReqId, result: f.result, error: f.error });
    } else if (isEvent(f)) {
      if (f.event === "status" && this.ext && f.params) this.ext.info = { ...this.ext.info, ...(f.params as Partial<ExtStatus>) };
      this.broadcast(f);
    }
  }

  // ---- client side --------------------------------------------------------------------------
  startUnix(): net.Server {
    const server = net.createServer((sock) => {
      const client: Client = { id: this.nextClientId++, sock, buf: "", connectedAt: new Date().toISOString(), pending: new Set() };
      this.clients.set(client.id, client);
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        client.buf += chunk;
        let nl: number;
        while ((nl = client.buf.indexOf("\n")) >= 0) {
          const line = client.buf.slice(0, nl);
          client.buf = client.buf.slice(nl + 1);
          if (line.trim()) this.fromClient(client, parseFrame(line));
        }
      });
      const drop = () => {
        this.clients.delete(client.id);
        for (const id of client.pending) {
          const p = this.pending.get(id);
          if (p) clearTimeout(p.timer);
          this.pending.delete(id);
        }
      };
      sock.on("close", drop);
      sock.on("error", drop);
    });
    server.on("error", (e) => {
      log("unix socket error:", e);
      process.exit(1);
    });
    server.listen(this.sockPath, () => {
      fs.chmodSync(this.sockPath, 0o600);
      log(`listening: ws://127.0.0.1:${this.port} (extension), ${this.sockPath} (mcp clients)`);
    });
    return server;
  }

  private fromClient(client: Client, f: Frame | null): void {
    if (!f || !isRequest(f)) return;
    if (f.method.startsWith("broker.")) return this.reply(client, this.brokerMethod(f));
    if (!this.ext) {
      return this.reply(client, {
        id: f.id,
        error: fwError("NOT_PAIRED", "no extension connected: is Firefox running with foxwire installed and the secret pasted in its options?").toJSON(),
      });
    }
    const id = this.nextReqId++;
    const requested = Number((f.params as { timeoutMs?: unknown } | undefined)?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const ceiling = Math.min(Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS) + GRACE_MS;
    const timer = setTimeout(() => {
      this.pending.delete(id);
      client.pending.delete(id);
      this.reply(client, { id: f.id, error: fwError("TIMEOUT", `${f.method}: extension did not answer within ${ceiling} ms`).toJSON() });
    }, ceiling);
    this.pending.set(id, { client, clientReqId: f.id, timer });
    client.pending.add(id);
    this.ext.ws.send(JSON.stringify({ id, method: f.method, params: f.params } satisfies RequestFrame));
  }

  private brokerMethod(f: RequestFrame): ResponseFrame {
    switch (f.method) {
      case "broker.status": {
        const result: BrokerStatus = {
          paired: !!this.ext,
          clients: this.clients.size,
          secretPath: secretPath(),
          port: this.port,
          brokerPid: process.pid,
        };
        if (this.ext) result.extension = { extensionVersion: this.ext.info.extensionVersion, firefoxVersion: this.ext.info.firefoxVersion, connectedAt: this.ext.connectedAt };
        return { id: f.id, result };
      }
      case "broker.clients":
        return { id: f.id, result: [...this.clients.values()].map((c) => ({ id: c.id, connectedAt: c.connectedAt, pending: c.pending.size })) };
      default:
        return { id: f.id, error: fwError("BAD_PARAMS", `unknown broker method ${f.method}`).toJSON() };
    }
  }

  private reply(client: Client, frame: ResponseFrame): void {
    if (client.sock.destroyed) return;
    client.sock.write(JSON.stringify(frame) + "\n");
  }
  private broadcast(frame: EventFrame): void {
    const text = JSON.stringify(frame) + "\n";
    for (const c of this.clients.values()) if (!c.sock.destroyed) c.sock.write(text);
  }
  private failAllPending(err: FwError): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.client.pending.delete(id);
      this.reply(p.client, { id: p.clientReqId, error: { code: err.code, message: err.message } });
    }
    this.pending.clear();
  }
}

/** True if a live broker already answers on the socket. Removes a stale socket file otherwise. */
async function anotherBrokerAlive(sockPath: string): Promise<boolean> {
  if (!fs.existsSync(sockPath)) return false;
  const alive = await new Promise<boolean>((resolve) => {
    const s = net.createConnection(sockPath);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
  if (!alive) fs.rmSync(sockPath, { force: true });
  return alive;
}

export async function main(): Promise<void> {
  const sockPath = socketPath();
  if (await anotherBrokerAlive(sockPath)) {
    log(`another broker already serves ${sockPath}; exiting`);
    return;
  }
  const info = loadOrCreateSecret(secretPath());
  announceSecret(info);
  const broker = new Broker(info.secret, cfgPort(), sockPath);
  const wss = broker.startWs();
  const unix = broker.startUnix();
  const shutdown = (sig: string) => {
    log(`${sig}: shutting down`);
    wss.close();
    unix.close();
    fs.rmSync(sockPath, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  log(`broker pid ${process.pid}; log ${logPath()}`);
}

main().catch((e) => {
  log("fatal:", e?.stack ?? e);
  process.exit(1);
});
