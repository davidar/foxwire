// Integration test: a real broker child process, a fake extension over ws, and fake mcp clients over the
// Unix socket. Everything lives in a temp dir with its own port; the real socket/port/config are never touched.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { hmacHex } from "../shared/hmac.ts";
import { parseFrame, type Frame } from "../shared/protocol.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WAIT_MS = 3_000;

// ---- small event-based helpers ----------------------------------------------------------------

type J = Record<string, any>;

/** A FIFO of parsed frames with predicate-based waiting. */
class Inbox {
  private frames: J[] = [];
  private waiters: { pred: (f: J) => boolean; resolve: (f: J) => void }[] = [];
  push(f: J): void {
    const i = this.waiters.findIndex((w) => w.pred(f));
    if (i >= 0) return this.waiters.splice(i, 1)[0]!.resolve(f);
    this.frames.push(f);
  }
  next(pred: (f: J) => boolean, ms = WAIT_MS, what = "frame"): Promise<J> {
    const i = this.frames.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.frames.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const w = {
        pred,
        resolve: (f: J) => {
          clearTimeout(timer);
          resolve(f);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        reject(new Error(`timed out after ${ms} ms waiting for ${what}`));
      }, ms);
      this.waiters.push(w);
    });
  }
}

/** A fake mcp client: newline-delimited JSON over the Unix socket. */
class UnixClient {
  inbox = new Inbox();
  private buf = "";
  private sock: net.Socket;
  private constructor(sock: net.Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      this.buf += chunk;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const f = parseFrame(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
        if (f) this.inbox.push(f as J);
      }
    });
  }
  static connect(p: string): Promise<UnixClient> {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(p);
      s.once("connect", () => resolve(new UnixClient(s)));
      s.once("error", reject);
    });
  }
  send(f: Frame): void {
    this.sock.write(JSON.stringify(f) + "\n");
  }
  async call(id: number, method: string, params: J = {}, ms = WAIT_MS): Promise<J> {
    this.send({ id, method, params });
    return this.inbox.next((f) => f.id === id, ms, `reply to ${method} #${id}`);
  }
  event(name: string, ms = WAIT_MS): Promise<J> {
    return this.inbox.next((f) => f.event === name, ms, `event ${name}`);
  }
  close(): void {
    this.sock.destroy();
  }
}

/** A fake extension: a ws client with a moz-extension Origin. */
class FakeExt {
  inbox = new Inbox();
  closed: Promise<{ code: number; reason: string }>;
  ws: WebSocket;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (d) => {
      const f = parseFrame(d.toString());
      if (f) this.inbox.push(f as J);
    });
    this.closed = new Promise((resolve) => ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() })));
  }
  static open(port: number): Promise<FakeExt> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "moz-extension://test" });
    const ext = new FakeExt(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(ext));
      ws.once("error", reject);
    });
  }
  send(f: J): void {
    this.ws.send(JSON.stringify(f));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

// ---- fixture ----------------------------------------------------------------------------------

let tmp: string;
let sockPath: string;
let cfgDir: string;
let port: number;
let broker: ChildProcess;
let brokerExit: Promise<number | null>;
let stderr = "";
let client: UnixClient;
let ext: FakeExt;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foxwire-broker-"));
  sockPath = path.join(tmp, "fw.sock");
  cfgDir = path.join(tmp, "cfg");
  port = await freePort();
  broker = spawn(process.execPath, [path.join(repo, "broker/broker.ts")], {
    env: { ...process.env, FOXWIRE_CONFIG_DIR: cfgDir, FOXWIRE_SOCKET: sockPath, FOXWIRE_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  brokerExit = new Promise((resolve) => broker.once("exit", (code) => resolve(code)));
  broker.stderr!.setEncoding("utf8");
  broker.stderr!.on("data", (d: string) => (stderr += d));

  // Poll until the socket accepts a connection (the broker logs "listening" just after chmod).
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (broker.exitCode !== null) throw new Error(`broker exited early (${broker.exitCode}):\n${stderr}`);
    if (fs.existsSync(sockPath) && stderr.includes("listening:")) {
      try {
        client = await UnixClient.connect(sockPath);
        break;
      } catch {
        /* not yet */
      }
    }
    if (Date.now() > deadline) throw new Error(`broker did not start:\n${stderr}`);
    await new Promise((r) => setTimeout(r, 25));
  }
});

after(async () => {
  client?.close();
  ext?.ws.terminate();
  if (broker && broker.exitCode === null) {
    broker.kill("SIGTERM");
    assert.equal(await brokerExit, 0, `broker exit code; stderr:\n${stderr}`);
  }
  assert.equal(fs.existsSync(sockPath), false, "socket file removed on SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---- tests (run in order; they share one broker) ----------------------------------------------

test("a. broker.status before pairing", async () => {
  const r = await client.call(1, "broker.status");
  assert.equal(r.error, undefined);
  assert.equal(r.result.paired, false);
  assert.equal(r.result.clients, 1);
  assert.equal(r.result.port, port);
  assert.equal(r.result.secretPath, path.join(cfgDir, "secret"));
  assert.equal(fs.statSync(sockPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(cfgDir, "secret")).mode & 0o777, 0o600);
});

test("b. extension method before pairing → NOT_PAIRED", async () => {
  const r = await client.call(2, "listTabs");
  assert.equal(r.error?.code, "NOT_PAIRED");
});

test("b2. unknown broker method → BAD_PARAMS", async () => {
  const r = await client.call(3, "broker.nope");
  assert.equal(r.error?.code, "BAD_PARAMS");
});

test("c. ws without a moz-extension Origin is refused", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let gotMessage = false;
  ws.on("message", () => (gotMessage = true));
  const outcome = await new Promise<string>((resolve) => {
    ws.once("unexpected-response", (_req, res) => {
      resolve(`http ${res.statusCode}`);
      ws.terminate();
    });
    ws.once("error", () => resolve("error"));
    ws.once("open", () => resolve("open"));
  });
  assert.notEqual(outcome, "open");
  assert.equal(gotMessage, false);
  const web = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "https://evil.example" });
  const outcome2 = await new Promise<string>((resolve) => {
    web.once("unexpected-response", () => {
      resolve("refused");
      web.terminate();
    });
    web.once("error", () => resolve("refused"));
    web.once("open", () => resolve("open"));
  });
  assert.equal(outcome2, "refused");
});

test("d. wrong hmac → close 4001", async () => {
  const bad = await FakeExt.open(port);
  const hello = await bad.inbox.next((f) => f.event === "hello", WAIT_MS, "hello");
  assert.match(hello.params.nonce, /^[0-9a-f]{64}$/);
  assert.equal(hello.params.protocol, 1);
  bad.send({ event: "auth", params: { hmac: "0".repeat(64), extensionVersion: "x", firefoxVersion: "x" } });
  const { code } = await bad.closed;
  assert.equal(code, 4001);
  assert.equal((await client.call(4, "broker.status")).result.paired, false);
});

test("e. correct handshake, then requests round-trip", async () => {
  ext = await FakeExt.open(port);
  const hello = await ext.inbox.next((f) => f.event === "hello", WAIT_MS, "hello");
  const secret = fs.readFileSync(path.join(cfgDir, "secret"), "utf8").trim();
  ext.send({
    event: "auth",
    params: { hmac: await hmacHex(secret, hello.params.nonce), extensionVersion: "0.0.0-test", firefoxVersion: "157.0" },
  });
  await ext.inbox.next((f) => f.event === "paired", WAIT_MS, "paired");
  const connected = await client.event("ext.connected");
  assert.equal(connected.params.extensionVersion, "0.0.0-test");

  client.send({ id: 5, method: "listTabs", params: {} });
  const req = await ext.inbox.next((f) => f.method === "listTabs", WAIT_MS, "forwarded listTabs");
  assert.equal(typeof req.id, "number");
  assert.deepEqual(req.params, {});
  const tabs = [{ tabId: 1, windowId: 1, index: 0, title: "t", url: "https://example.com/", active: true, windowFocused: true, status: "complete" }];
  ext.send({ id: req.id, result: tabs });
  const r = await client.inbox.next((f) => f.id === 5, WAIT_MS, "listTabs reply");
  assert.deepEqual(r, { id: 5, result: tabs });

  // Errors from the extension pass through with their code.
  client.send({ id: 7, method: "click", params: { tabId: 1, uid: "9" } });
  const req2 = await ext.inbox.next((f) => f.method === "click", WAIT_MS, "forwarded click");
  ext.send({ id: req2.id, error: { code: "STALE_UID", message: "uid 9 is gone" } });
  const r2 = await client.inbox.next((f) => f.id === 7, WAIT_MS, "click reply");
  assert.equal(r2.error.code, "STALE_UID");

  const s = await client.call(8, "broker.status");
  assert.equal(s.result.paired, true);
  assert.equal(s.result.extension.extensionVersion, "0.0.0-test");
  assert.equal(s.result.extension.firefoxVersion, "157.0");
});

test("f. extension events are broadcast to clients", async () => {
  const other = await UnixClient.connect(sockPath);
  try {
    // Make sure the broker has registered the second client before the event is sent.
    await other.call(1, "broker.status");
    ext.send({ event: "tab.removed", params: { tabId: 1 } });
    for (const c of [client, other]) assert.deepEqual(await c.event("tab.removed"), { event: "tab.removed", params: { tabId: 1 } });
  } finally {
    other.close();
  }
});

test("g. extension never answers → TIMEOUT after timeoutMs + grace", async () => {
  const t0 = Date.now();
  client.send({ id: 6, method: "snapshot", params: { tabId: 1, timeoutMs: 1000 } });
  await ext.inbox.next((f) => f.method === "snapshot", WAIT_MS, "forwarded snapshot");
  const r = await client.inbox.next((f) => f.id === 6, 10_000, "snapshot timeout");
  const took = Date.now() - t0;
  assert.equal(r.error?.code, "TIMEOUT");
  assert.ok(took >= 5_000 && took <= 9_000, `took ${took} ms`);
});

test("h. extension disconnect fails pending calls and unpairs", async () => {
  client.send({ id: 9, method: "pageText", params: { tabId: 1 } });
  await ext.inbox.next((f) => f.method === "pageText", WAIT_MS, "forwarded pageText");
  ext.ws.close(1000, "bye");
  const r = await client.inbox.next((f) => f.id === 9, WAIT_MS, "pageText failure");
  assert.equal(r.error?.code, "NOT_PAIRED");
  await client.event("ext.disconnected");
  const s = await client.call(10, "broker.status");
  assert.equal(s.result.paired, false);
  assert.equal(s.result.extension, undefined);
});
