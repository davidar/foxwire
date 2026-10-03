// Unix-socket client to the broker (docs/DESIGN.md §2, §4). Lazy: connects on the first request, and spawns
// the broker detached if nothing answers on the socket. Never writes to stdout (that is the MCP transport).
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  FwErrorImpl,
  fwError,
  isEvent,
  isResponse,
  parseFrame,
  type EventFrame,
  type RequestFrame,
} from "../shared/protocol.ts";
import { configDir, logPath, socketPath } from "../broker/paths.ts";

const CLIENT_GRACE_MS = 7_000; // broker gives up at +5 s; we give it 2 s more to say so
const SPAWN_WAIT_MS = 5_000;

export const log = (msg: string) => process.stderr.write(`foxwire-mcp: ${msg}\n`);

function brokerEntry(): string {
  if (process.env.FOXWIRE_BROKER) return process.env.FOXWIRE_BROKER;
  const here = path.dirname(fileURLToPath(import.meta.url));
  // bundled: mcp/dist/server.js → broker/dist/broker.js; unbundled: mcp/client.ts → broker/dist/broker.js
  const root = path.basename(here) === "dist" ? path.resolve(here, "../..") : path.resolve(here, "..");
  return path.join(root, "broker", "dist", "broker.js");
}

function dial(sock: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    s.once("connect", () => {
      s.removeListener("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
}

function spawnBroker(): void {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const logFd = fs.openSync(logPath(), "a");
  const entry = brokerEntry();
  log(`starting broker ${entry} (log ${logPath()})`);
  const child = spawn(process.execPath, [entry], { detached: true, stdio: ["ignore", logFd, logFd], env: process.env });
  child.on("error", (e) => log(`broker spawn failed: ${e.message}`));
  child.unref();
  fs.closeSync(logFd);
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class BrokerClient {
  private sock: net.Socket | null = null;
  private connecting: Promise<net.Socket> | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners: ((e: EventFrame) => void)[] = [];

  onEvent(cb: (e: EventFrame) => void): void {
    this.listeners.push(cb);
  }

  async request<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const sock = await this.ensure();
    const id = this.nextId++;
    const requested = Number(params.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const ceiling = Math.min(Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS) + CLIENT_GRACE_MS;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fwError("TIMEOUT", `${method}: no answer from the broker within ${ceiling} ms`));
      }, ceiling);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      sock.write(JSON.stringify({ id, method, params } satisfies RequestFrame) + "\n");
    });
  }

  close(): void {
    this.sock?.destroy();
  }

  private ensure(): Promise<net.Socket> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(this.sock);
    this.connecting ??= this.connect().finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connect(): Promise<net.Socket> {
    const sockPath = socketPath();
    let sock: net.Socket | null = null;
    try {
      sock = await dial(sockPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw fwError("NO_BROKER", `cannot reach ${sockPath}: ${String(e)}`);
      try {
        spawnBroker();
      } catch (se) {
        throw fwError("NO_BROKER", `could not start the broker: ${String(se)}; see ${logPath()}`);
      }
      const deadline = Date.now() + SPAWN_WAIT_MS;
      for (let delay = 100; !sock && Date.now() < deadline; delay *= 2) {
        await new Promise((r) => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))));
        sock = await dial(sockPath).catch(() => null);
      }
      if (!sock) throw fwError("NO_BROKER", `could not start or reach the broker at ${sockPath}; see ${logPath()}`);
    }
    this.attach(sock);
    return sock;
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    this.buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.trim()) this.onLine(line);
      }
    });
    const lost = () => {
      if (this.sock !== sock) return;
      this.sock = null;
      const err = fwError("NO_BROKER", "broker connection lost; retry the call (it will respawn the broker)");
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    };
    sock.on("close", lost);
    sock.on("error", (e) => {
      log(`broker socket error: ${e.message}`);
      lost();
    });
  }

  private onLine(line: string): void {
    const f = parseFrame(line);
    if (!f) return;
    if (isEvent(f)) {
      if (f.event === "ext.connected") log("extension connected");
      else if (f.event === "ext.disconnected") log(`extension disconnected (${String(f.params?.reason ?? "")})`);
      for (const cb of this.listeners) {
        try {
          cb(f);
        } catch (e) {
          log(`event listener threw: ${String(e)}`);
        }
      }
      return;
    }
    if (!isResponse(f)) return;
    const p = this.pending.get(f.id);
    if (!p) return;
    this.pending.delete(f.id);
    clearTimeout(p.timer);
    if (f.error) p.reject(new FwErrorImpl(f.error.code, f.error.message, f.error.data));
    else p.resolve(f.result);
  }
}
