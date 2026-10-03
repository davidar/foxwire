// foxwire background (MV2, persistent): dials the loopback broker, authenticates with HMAC, and serves
// ExtMethods with tabs.* / executeScript / captureTab. docs/DESIGN.md §2–§7. No content_scripts, ever.
import {
  DEFAULT_PORT, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, PROTOCOL_VERSION, capIntent, fwError, isFwError, parseFrame, parseUid,
  type ExtMethods, type ExtStatus, type FwError, type RequestFrame, type ResponseFrame,
  type ScreenshotResult, type SnapshotResult, type TabInfo, type WaitUntil,
} from "../shared/protocol.ts";
import { hmacHex, randomHex } from "../shared/hmac.ts";
import { bubbleCss, type ActivityEntry, type Anchor } from "./bubble.ts";

type Settings = { secret?: string; port?: number; evaluateEnabled?: boolean; bubbleEnabled?: boolean };
type P = Record<string, any>;

let settings: Settings = {};
const state = { connected: false, paired: false, lastError: "" as string, since: Date.now() };
let ws: WebSocket | null = null;
let backoffMs = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

const VERSION = browser.runtime.getManifest().version;
const ffVersion = browser.runtime.getBrowserInfo().then((i) => i.version, () => "?");
const BUNDLES = ["snapshot", "actions", "dialog", "evaluate"] as const;
type Bundle = (typeof BUNDLES)[number];
const sources = Object.fromEntries(
  BUNDLES.map((n) => {
    const p = fetch(browser.runtime.getURL(`dist/inject/${n}.js`)).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`dist/inject/${n}.js missing; rebuild the extension`))));
    p.catch(() => {}); // surfaced as INJECT_FAILED on first use
    return [n, p];
  }),
) as Record<Bundle, Promise<string>>;

/** `since` marks the last change of connected/paired, not of lastError (which repeats while retrying). */
function setState(patch: Partial<typeof state>): void {
  const moved = (patch.connected ?? state.connected) !== state.connected || (patch.paired ?? state.paired) !== state.paired;
  Object.assign(state, patch, moved ? { since: Date.now() } : {});
}

// ---- broker connection ---------------------------------------------------------------------------

function send(frame: object): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

function scheduleReconnect(): void {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30_000);
}

function disconnect(): void {
  clearTimeout(reconnectTimer);
  if (!ws) return;
  const old = ws;
  ws = null;
  old.onopen = old.onmessage = old.onclose = old.onerror = null;
  try {
    old.close(1000, "reconnecting");
  } catch {}
  setState({ connected: false, paired: false });
}

function connect(): void {
  disconnect();
  if (!settings.secret) {
    setState({ lastError: "no secret set" });
    return;
  }
  const secret = settings.secret;
  const port = settings.port ?? DEFAULT_PORT;
  const sock = new WebSocket(`ws://127.0.0.1:${port}`); // port validated in loadSettings, so this cannot throw
  ws = sock;
  sock.onopen = () => setState({ connected: true, lastError: "" });
  sock.onerror = () => setState({ lastError: `cannot reach broker on 127.0.0.1:${port}` });
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    if (ev.code === 4001) setState({ lastError: "secret mismatch (close 4001)" });
    else if (ev.code === 4002) setState({ lastError: "superseded by another foxwire connection (close 4002)" });
    else if (state.paired || !state.lastError) setState({ lastError: `connection closed (${ev.code}${ev.reason ? " " + ev.reason : ""})` });
    setState({ connected: false, paired: false });
    scheduleReconnect();
  };
  sock.onmessage = async (ev) => {
    const f = parseFrame(String(ev.data));
    if (!f) return;
    if ("event" in f) {
      if (f.event === "hello") {
        const nonce = String((f.params as { nonce?: unknown } | undefined)?.nonce ?? "");
        const proto = (f.params as { protocol?: unknown } | undefined)?.protocol;
        if (proto !== PROTOCOL_VERSION) setState({ lastError: `broker speaks protocol ${String(proto)}, extension ${PROTOCOL_VERSION}` });
        try {
          const hmac = await hmacHex(secret, nonce);
          send({ event: "auth", params: { hmac, extensionVersion: VERSION, firefoxVersion: await ffVersion } });
        } catch (e) {
          setState({ lastError: `secret is not valid hex: ${(e as Error).message}` });
          sock.close(1000, "bad secret");
        }
      } else if (f.event === "paired") {
        backoffMs = 1000;
        setState({ paired: true, lastError: "" });
        void sendStatus();
      }
      return;
    }
    if (state.paired && "method" in f && typeof f.method === "string") void handle(f as RequestFrame);
  };
}

async function sendStatus(): Promise<void> {
  if (state.paired) send({ event: "status", params: await extStatus() });
}

async function extStatus(): Promise<ExtStatus> {
  const grants = (await browser.permissions.getAll()).origins ?? [];
  return { extensionVersion: VERSION, firefoxVersion: await ffVersion, grants, evaluateEnabled: !!settings.evaluateEnabled, bubbleEnabled: !!settings.bubbleEnabled, asking: [...asks.keys()] };
}

// ---- request dispatch ----------------------------------------------------------------------------

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function handle(req: RequestFrame): Promise<void> {
  const params = (req.params ?? {}) as P;
  const intent = typeof params.intent === "string" ? capIntent(params.intent.trim()) : "";
  const reqTab: number | undefined = Number.isInteger(params.tabId) ? params.tabId : undefined;
  if (intent && reqTab !== undefined && Object.hasOwn(METHODS, req.method) && req.method !== "requestGrant") {
    void browser.browserAction.setBadgeText({ tabId: reqTab, text: "…" }).catch(() => {});
    if (!AFTER_LOAD.has(req.method)) await Promise.race([showBubble(reqTab, intent, params.uid).catch(() => {}), sleep(400)]);
  }
  const timeoutMs = clamp(Number(params.timeoutMs) || (req.method === "requestGrant" ? MAX_TIMEOUT_MS : DEFAULT_TIMEOUT_MS), 1000, MAX_TIMEOUT_MS);
  const fn = (METHODS as Record<string, ((p: P, t: number) => Promise<unknown>) | undefined>)[req.method];
  let frame: ResponseFrame;
  if (!Object.hasOwn(METHODS, req.method) || !fn) {
    frame = { id: req.id, error: { code: "BAD_PARAMS", message: `unknown method ${req.method}` } };
  } else {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(fwError("TIMEOUT", `${req.method} did not finish within ${timeoutMs} ms`)), timeoutMs);
    });
    try {
      frame = { id: req.id, result: (await Promise.race([fn(params, timeoutMs), expiry])) ?? null };
    } catch (e) {
      frame = { id: req.id, error: toFwError(e) };
    } finally {
      clearTimeout(timer);
    }
  }
  send(frame);
  const tabId = req.method === "createTab" ? (frame.result as TabInfo | null)?.tabId : reqTab;
  if (tabId !== undefined && Object.hasOwn(METHODS, req.method)) afterCall(tabId, req.method, intent, frame.error?.code ?? "ok");
}

// ---- thought bubble and activity log (DESIGN §7.1) -------------------------------------------------

const BUBBLE_MS = 4000;
const AFTER_LOAD = new Set(["createTab", "navigate", "history", "screenshot"]); // new document, or must stay out of the capture
const bubbles = new Map<number, { code: string; timer?: ReturnType<typeof setTimeout> }>();
const activity: ActivityEntry[] = [];
const cssDetails = (code: string) => ({ code, cssOrigin: "user" as const, frameId: 0, runAt: "document_start" as const });

async function hideBubble(tabId: number): Promise<void> {
  const b = bubbles.get(tabId);
  if (!b) return;
  bubbles.delete(tabId);
  focusFrame.delete(tabId);
  clearTimeout(b.timer);
  await browser.tabs.removeCSS(tabId, cssDetails(b.code)).catch(() => {});
}

/** Throws on privileged/ungranted pages (callers swallow); a failed anchor lookup falls back to bottom-centre. */
async function showBubble(tabId: number, intent: string, uid: unknown): Promise<void> {
  if (!settings.bubbleEnabled) return;
  await checkGrant(tabId);
  let anchor: Anchor | undefined;
  if (uid !== undefined) {
    const where = (() => { try { return parseUid(uid); } catch { return null; } })();
    if (where?.frame === 0) {
      const r = inject(tabId, "actions", { op: "rect", uid: where.uid, viewport: true }, { timeoutMs: 1000 });
      anchor = (await Promise.race([r.catch(() => undefined), sleep(300)])) as Anchor | undefined;
    }
  }
  const code = bubbleCss(intent, anchor);
  await hideBubble(tabId);
  bubbles.set(tabId, { code });
  await browser.tabs.insertCSS(tabId, cssDetails(code));
}

function afterCall(tabId: number, method: string, intent: string, outcome: string): void {
  const entry: ActivityEntry = { time: Date.now(), tabId, title: "", method, intent, outcome };
  activity.unshift(entry);
  activity.length = Math.min(activity.length, 50);
  void browser.tabs.get(tabId).then((t) => (entry.title = (t.title || t.url || "").slice(0, 100)), () => (entry.title = "(closed)"));
  if (!intent || method === "requestGrant") return;
  void browser.browserAction.setBadgeText({ tabId, text: null }).catch(() => {}); // null: inherit the global "?" of a grant request
  if (!asks.size) void browser.browserAction.setTitle({ title: `foxwire: ${intent}` }).catch(() => {});
  const linger = () => {
    const b = bubbles.get(tabId);
    if (!b) return;
    clearTimeout(b.timer);
    b.timer = setTimeout(() => void hideBubble(tabId), BUBBLE_MS);
  };
  if (AFTER_LOAD.has(method)) void showBubble(tabId, intent, undefined).then(linger, () => {});
  else linger();
}

function toFwError(e: unknown): FwError {
  if (isFwError(e)) return e.data === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, data: e.data };
  return { code: "INJECT_FAILED", message: (e as Error)?.message ?? String(e) };
}

function needTab(p: P): number {
  if (typeof p.tabId !== "number" || !Number.isInteger(p.tabId)) throw fwError("BAD_PARAMS", "tabId (integer) is required");
  return p.tabId;
}

function getTab(tabId: number): Promise<browser.tabs.Tab> {
  return browser.tabs.get(tabId).catch(() => Promise.reject(fwError("NO_TAB", `tab ${tabId} does not exist (closed?); list_pages to pick another`)));
}

/** Ungranted http(s) tabs are listed without query string or fragment, so session tokens stay out of the model's context. */
async function shownUrl(raw: string): Promise<string> {
  const u = URL.parse(raw);
  if (!u || !/^https?:$/.test(u.protocol) || !(u.search || u.hash)) return raw;
  if (await browser.permissions.contains({ origins: [`${u.protocol}//${u.hostname}/*`] })) return raw;
  return `${u.origin}${u.pathname}?…`;
}

async function tabInfo(t: browser.tabs.Tab, focusedWindow?: number): Promise<TabInfo> {
  return {
    tabId: t.id ?? -1, windowId: t.windowId ?? -1, index: t.index, title: t.title ?? "", url: await shownUrl(t.url ?? ""),
    active: !!t.active, windowFocused: focusedWindow !== undefined && t.windowId === focusedWindow, status: t.status ?? "",
  };
}

// ---- frame aliases: subframe uids say f<k>_…, k per tab in first-seen order (DESIGN §6) ---------------

const frameAliases = new Map<number, number[]>(); // tabId → frameIds; alias k is index k-1
function aliasOf(tabId: number, frameId: number): number {
  const list = frameAliases.get(tabId) ?? [];
  frameAliases.set(tabId, list);
  const i = list.indexOf(frameId);
  return i >= 0 ? i + 1 : list.push(frameId);
}
/** uid → its frame's frameId; a frame alias that maps to nothing any more is STALE_UID. */
function resolveUid(tabId: number, uid: unknown): { frameId: number; uid: string } {
  const { frame, uid: n } = parseUid(uid);
  const frameId = frame ? frameAliases.get(tabId)?.[frame - 1] : 0;
  if (frameId === undefined) throw fwError("STALE_UID", `uid ${String(uid)}: frame f${frame} is gone (navigation or extension reload since that snapshot); take_snapshot again`);
  return { frameId, uid: n };
}
async function frameLabel(tabId: number, frameId: number): Promise<string> {
  if (!frameId) return "top frame";
  const f = await browser.webNavigation.getFrame({ tabId, frameId }).catch(() => null);
  return `frame f${aliasOf(tabId, frameId)} ${URL.parse(f?.url ?? "")?.origin ?? "(origin unknown)"}`;
}

// ---- load waiting --------------------------------------------------------------------------------

/** Start listening before the navigation is triggered; call setTab once the id is known. */
function loadWaiter(wait: WaitUntil | undefined, timeoutMs: number, targetUrl?: string) {
  const mode = wait ?? "complete";
  let target: number | undefined;
  const seen = new Set<number>();
  const allowBlank = !!targetUrl && targetUrl.startsWith("about:");
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const done = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  const hit = (tabId: number, url: string | undefined) => {
    if (!allowBlank && url === "about:blank") return;
    if (target === undefined) seen.add(tabId);
    else if (tabId === target) resolve();
  };
  const onUpdated = (tabId: number, ci: { status?: string }, tab: browser.tabs.Tab) => {
    if (ci.status === "complete") hit(tabId, tab.url);
  };
  const onDcl = (d: { tabId: number; frameId: number; url: string }) => {
    if (d.frameId === 0) hit(d.tabId, d.url);
  };
  const msg = `page still loading after ${timeoutMs} ms; it may be usable — try take_snapshot`;
  const timer = setTimeout(() => reject(fwError("TIMEOUT", msg)), timeoutMs - 100);
  if (mode === "complete") browser.tabs.onUpdated.addListener(onUpdated);
  else if (mode === "interactive") browser.webNavigation.onDOMContentLoaded.addListener(onDcl);
  const cleanup = () => {
    clearTimeout(timer);
    browser.tabs.onUpdated.removeListener(onUpdated);
    browser.webNavigation.onDOMContentLoaded.removeListener(onDcl);
  };
  return {
    setTab(id: number) {
      target = id;
      if (mode === "none" || seen.has(id)) resolve();
    },
    cancel: cleanup,
    done: done.finally(cleanup),
  };
}

async function navigateWith(timeoutMs: number, wait: WaitUntil | undefined, url: string | undefined, start: () => Promise<number>): Promise<TabInfo> {
  const w = loadWaiter(wait, timeoutMs, url);
  let tabId: number;
  try {
    tabId = await start();
  } catch (e) {
    w.cancel();
    const msg = (e as Error)?.message ?? String(e);
    throw isFwError(e) ? e : fwError(/url/i.test(msg) ? "BAD_PARAMS" : "INJECT_FAILED", `could not open ${url ?? "history entry"}: ${msg}`);
  }
  w.setTab(tabId);
  await w.done;
  return tabInfo(await getTab(tabId));
}

// ---- injection -----------------------------------------------------------------------------------

type FrameReply = { ok: true; result: unknown } | { ok: false; error: FwError };

/** The one origin pattern a page needs; privileged/unsupported schemes cannot be granted at all. */
function grantPattern(raw: string): { pattern: string; origin: string } {
  const url = URL.parse(raw);
  if (!url || !["http:", "https:", "file:"].includes(url.protocol)) throw fwError("INJECT_FAILED", `cannot run on privileged page ${raw || "(no url)"}`);
  return url.protocol === "file:" ? { pattern: "file:///*", origin: "file://" } : { pattern: `${url.protocol}//${url.hostname}/*`, origin: url.origin };
}
const hasGrant = (pattern: string) => browser.permissions.contains({ origins: [pattern] });

async function checkGrant(tabId: number): Promise<void> {
  const { pattern, origin } = grantPattern((await getTab(tabId)).url ?? "");
  if (!(await hasGrant(pattern))) throw fwError("NO_GRANT", `no host grant for ${origin}; the user can grant ${pattern} in the foxwire toolbar popup or options page`, { origin, pattern });
}

// ---- just-in-time grant requests (DESIGN §3): the popup asks the user; the outcome arrives via permissions.onAdded ----

type Ask = { id: string; pattern: string; origin: string; intent: string; title: string; createdAt: number; waiters: Set<(ok: boolean) => void>; drop?: ReturnType<typeof setTimeout> };
const asks = new Map<string, Ask>(); // by pattern
const declined = new Map<string, number>(); // pattern → when the user said no
const DECLINE_MEMORY_MS = 10 * 60_000;
const LATE_ANSWER_MS = 2 * 60_000; // an unanswered request stays in the popup this long after the call gives up

function askBadge(): void {
  const first = asks.values().next().value;
  void browser.browserAction.setBadgeText({ text: first ? "?" : "" }).catch(() => {});
  void browser.browserAction.setBadgeBackgroundColor({ color: first ? "#e8590c" : null }).catch(() => {});
  void browser.browserAction.setTitle({ title: first ? `Claude wants access to ${first.origin}` : null }).catch(() => {});
}

function settleAsk(a: Ask, ok: boolean): void {
  if (asks.get(a.pattern) !== a) return;
  asks.delete(a.pattern);
  clearTimeout(a.drop);
  if (!ok) declined.set(a.pattern, Date.now());
  for (const w of a.waiters) w(ok);
  askBadge();
}

async function recheckAsks(): Promise<void> {
  for (const a of [...asks.values()]) if (await hasGrant(a.pattern)) settleAsk(a, true);
}

async function requestGrant(p: P, timeoutMs: number): Promise<{ granted: true; pattern: string }> {
  const tab = Number.isInteger(p.tabId) ? await getTab(p.tabId) : undefined;
  if (!tab && typeof p.url !== "string") throw fwError("BAD_PARAMS", "tabId (integer) or url (string) is required");
  const { pattern, origin } = grantPattern(tab ? (tab.url ?? "") : p.url);
  if (await hasGrant(pattern)) return { granted: true, pattern };
  if (Date.now() - (declined.get(pattern) ?? -Infinity) < DECLINE_MEMORY_MS)
    throw fwError("NO_GRANT", `the user declined ${pattern} in the last 10 minutes; they can still grant it in the foxwire options page`, { origin, pattern });
  let a = asks.get(pattern);
  if (!a) {
    const intent = typeof p.intent === "string" ? capIntent(p.intent.trim()) : "";
    a = { id: randomHex(8), pattern, origin, intent, title: (tab?.title ?? "").slice(0, 100), createdAt: Date.now(), waiters: new Set() };
    asks.set(pattern, a);
    askBadge();
    void browser.browserAction.openPopup().catch(() => {}); // usually refused without a user gesture; the badge is the fallback
  }
  clearTimeout(a.drop);
  const ask = a;
  const waitMs = timeoutMs - 1000;
  const ok = await new Promise<boolean | null>((res) => {
    const timer = setTimeout(() => (ask.waiters.delete(done), res(null)), waitMs);
    const done = (v: boolean) => (clearTimeout(timer), res(v));
    ask.waiters.add(done);
    void recheckAsks(); // granted between the check above and registering
  });
  if (ok) return { granted: true, pattern };
  if (ok === false) throw fwError("NO_GRANT", `the user was asked and declined ${pattern}`, { origin, pattern });
  if (!ask.waiters.size) ask.drop = setTimeout(() => (asks.get(pattern) === ask && asks.delete(pattern), askBadge()), LATE_ANSWER_MS);
  throw fwError("NO_GRANT", `the user was asked for ${pattern} but did not answer in ${Math.round(waitMs / 1000)} s; the request is still shown in the foxwire toolbar popup`, { origin, pattern });
}

function mapInjectError(e: unknown, tabId: number): FwError {
  if (isFwError(e)) return e;
  const msg = (e as Error)?.message ?? String(e);
  if (/Missing host permission/i.test(msg)) return fwError("NO_GRANT", `no host grant for a frame in tab ${tabId}: ${msg}`);
  if (/No tab|Invalid tab/i.test(msg)) return fwError("NO_TAB", `tab ${tabId} does not exist (closed?); list_pages to pick another`);
  return fwError("INJECT_FAILED", msg);
}

interface InjectOpts {
  frameId?: number;
  allFrames?: boolean;
  timeoutMs: number;
  /** Return as soon as any frame answers ok (wait_for across frames). */
  any?: boolean;
}

/** Inject a bundle; returns frameId → reply (frames that never answered before the deadline are absent). */
async function injectFrames(tabId: number, bundle: Bundle, args: P, o: InjectOpts): Promise<Map<number, FrameReply>> {
  await checkGrant(tabId);
  const callId = randomHex(12);
  // The inject sees a slightly shorter budget so its own TIMEOUT (e.g. wait_for's message) wins the race.
  const budget = Math.max(500, o.timeoutMs - 500);
  const code = `globalThis.__fw_args=${JSON.stringify({ ...args, __call: callId, timeoutMs: budget })};\n${await sources[bundle]}`;
  const replies = new Map<number, FrameReply>();
  let expected = Infinity;
  let wake = () => {};
  const settled = () => replies.size >= expected || (!!o.any && [...replies.values()].some((r) => r.ok));
  const dispatched = new Map<number, string>(); // frame → action note, sent once its events went out (actions.ts withEffect)
  const listener = (msg: unknown, sender: browser.runtime.MessageSender) => {
    const m = msg as { __fw?: unknown; ok?: boolean; result?: unknown; error?: FwError; dispatched?: string } | null;
    if (!m || m.__fw !== callId || sender.tab?.id !== tabId) return;
    if (typeof m.dispatched === "string") return void (dispatched.set(sender.frameId ?? 0, m.dispatched), setTimeout(() => wake(), 2000));
    replies.set(sender.frameId ?? 0, m.ok ? { ok: true, result: m.result } : { ok: false, error: m.error ?? { code: "INJECT_FAILED", message: "injected code failed" } });
    if (settled()) wake();
  };
  browser.runtime.onMessage.addListener(listener);
  try {
    const results = await browser.tabs
      .executeScript(tabId, { code, runAt: "document_idle", matchAboutBlank: true, ...(o.allFrames ? { allFrames: true } : { frameId: o.frameId ?? 0 }) })
      .catch((e) => Promise.reject(mapInjectError(e, tabId)));
    expected = results.length;
    if (!settled()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ok = await new Promise<boolean>((res) => {
        wake = () => res(true);
        timer = setTimeout(() => res(false), Math.max(200, o.timeoutMs - 300));
      });
      clearTimeout(timer);
      // The effect poll takes ≤400 ms, so no answer 2 s after dispatch means the frame unloaded: that is the effect.
      for (const [f, note] of dispatched) {
        if (!replies.has(f)) replies.set(f, { ok: true, result: { ok: true, note: `${note}\nafter: the page navigated or the frame was replaced` } });
      }
      if (!ok && (!o.allFrames || !replies.has(0))) throw fwError("TIMEOUT", `${bundle} script did not answer within ${o.timeoutMs} ms`);
    }
    return replies;
  } finally {
    browser.runtime.onMessage.removeListener(listener);
  }
}

async function inject(tabId: number, bundle: Bundle, args: P, o: InjectOpts): Promise<unknown> {
  const frameId = o.frameId ?? 0;
  const r = (await injectFrames(tabId, bundle, args, { ...o, frameId, allFrames: false })).get(frameId);
  if (!r) throw fwError("INJECT_FAILED", `frame ${frameId} of tab ${tabId} did not run the ${bundle} script (frame gone?)`);
  if (!r.ok) throw fwError(r.error.code, r.error.message, r.error.data);
  return r.result;
}

/** Inject into every frame; if a subframe's origin is not granted, fall back to the main frame alone. */
async function everyFrame(tabId: number, bundle: Bundle, args: P, timeoutMs: number, any = false): Promise<Map<number, FrameReply>> {
  try {
    return await injectFrames(tabId, bundle, args, { allFrames: true, timeoutMs, any });
  } catch (e) {
    if (!isFwError(e) || e.code !== "NO_GRANT") throw e;
    return injectFrames(tabId, bundle, args, { frameId: 0, timeoutMs, any });
  }
}

// ---- snapshot merge ------------------------------------------------------------------------------

async function snapshot(p: P, timeoutMs: number): Promise<SnapshotResult> {
  const tabId = needTab(p);
  // The walker applies the selector in the top frame only; subframes come back whole.
  const replies = await everyFrame(tabId, "snapshot", { selector: p.selector, includeAll: p.includeAll, maxNodes: p.maxNodes }, timeoutMs);
  const main = replies.get(0);
  if (!main) throw fwError("INJECT_FAILED", `main frame of tab ${tabId} did not answer the snapshot`);
  if (!main.ok) throw fwError(main.error.code, main.error.message, main.error.data);
  const top = main.result as SnapshotResult;
  const lines = [...top.lines];
  let truncated = top.truncated;
  const frames = (await browser.webNavigation.getAllFrames({ tabId }).catch(() => null)) ?? [];
  const urlOf = new Map(frames.map((f) => [f.frameId, f.url]));
  for (const [frameId, r] of [...replies].sort(([a], [b]) => a - b)) {
    if (frameId === 0) continue;
    const url = urlOf.get(frameId) ?? "";
    const k = aliasOf(tabId, frameId);
    const src = url.length > 70 ? url.slice(0, 69) : url;
    const at = url ? lines.findIndex((l) => /^\s*- iframe /.test(l) && l.includes(`src="${src}`)) : -1;
    if (at < 0 && p.selector) continue; // its iframe is outside the scoped subtree
    if (!r.ok) {
      lines.push(`- iframe [frame=f${k} url=${JSON.stringify(url)} error=${r.error.code}]`);
      continue;
    }
    const sub = r.result as SnapshotResult;
    truncated ||= sub.truncated;
    const rewritten = sub.lines.map((l) => l.replace(/\b(uid|controls)=(\d+[a-z]*)/g, `$1=f${k}_$2`));
    if (at >= 0) {
      const indent = (/^\s*/.exec(lines[at]!)?.[0] ?? "") + "  ";
      lines[at] += ` [frame=f${k} ${URL.parse(url)?.origin ?? ""}]`;
      lines.splice(at + 1, 0, ...rewritten.map((l) => indent + l));
    } else {
      lines.push(`- iframe [frame=f${k} url=${JSON.stringify(url)}]`, ...rewritten.map((l) => "  " + l));
    }
  }
  for (const f of frames) {
    if (!p.selector && f.frameId !== 0 && !replies.has(f.frameId) && /^https?:/.test(f.url)) {
      const { pattern, origin } = grantPattern(f.url);
      const why = (await hasGrant(pattern)) ? "no answer" : `no host grant for ${origin}; the user can grant ${pattern} in the foxwire options page`;
      lines.push(`- iframe [url=${JSON.stringify(f.url)} not snapshotted: ${why}]`);
    }
  }
  return { url: top.url, title: top.title, lines, frames: replies.size, truncated };
}

// ---- screenshot ----------------------------------------------------------------------------------

function pngSize(dataUrl: string): { width: number; height: number } {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1, dataUrl.indexOf(",") + 1 + 32);
  const bin = atob(b64);
  const u32 = (o: number) => ((bin.charCodeAt(o) << 24) | (bin.charCodeAt(o + 1) << 16) | (bin.charCodeAt(o + 2) << 8) | bin.charCodeAt(o + 3)) >>> 0;
  return { width: u32(16), height: u32(20) };
}

async function screenshot(p: P, timeoutMs: number): Promise<ScreenshotResult> {
  const tabId = needTab(p);
  const where = p.uid !== undefined ? resolveUid(tabId, p.uid) : { frameId: 0, uid: undefined };
  const rect = (await inject(tabId, "actions", { op: "rect", uid: where.uid, fullPage: !!p.fullPage }, { frameId: where.frameId, timeoutMs })) as {
    x: number; y: number; width: number; height: number;
  };
  if (p.fullPage) Object.assign(rect, { width: Math.min(rect.width, 5000), height: Math.min(rect.height, 10000) });
  if (rect.width <= 0 || rect.height <= 0) throw fwError("INJECT_FAILED", `nothing to capture: element has size ${rect.width}x${rect.height}`);
  await hideBubble(tabId); // never in the capture; re-shown after the call
  // Firefox only exposes captureTab while the extension holds <all_urls>; a per-origin grant is not enough.
  if (typeof browser.tabs.captureTab !== "function")
    throw fwError("NO_GRANT", 'screenshots need the "Grant all sites" grant (<all_urls>) in the foxwire options page; per-origin grants cannot capture', { pattern: "<all_urls>" });
  const dataUrl = await browser.tabs.captureTab(tabId, { format: "png", rect, scale: 1 } as browser.extensionTypes.ImageDetails).catch((e) => {
    const msg = (e as Error)?.message ?? String(e);
    if (!/permission/i.test(msg)) throw mapInjectError(e, tabId);
    throw fwError("NO_GRANT", `screenshot refused: ${msg}; captureTab may need the "all sites" grant in the foxwire options page`);
  });
  return { dataUrl, ...pngSize(dataUrl) };
}

// ---- methods -------------------------------------------------------------------------------------

const ACTION_OPS = ["click", "hover", "fill", "type", "press", "selectOption", "upload"] as const;
/** Frame that last received a uid-targeted action, per tab: uid-less press/type follow focus into it. */
const focusFrame = new Map<number, number>();
function action(op: string) {
  return async (p: P, timeoutMs: number) => {
    const tabId = needTab(p);
    const { tabId: _t, timeoutMs: _m, intent: _i, ...rest } = p;
    const run = (frameId: number, uid?: string) => inject(tabId, "actions", { ...rest, op, uid }, { frameId, timeoutMs });
    if (p.uid !== undefined) {
      const where = resolveUid(tabId, p.uid);
      if (!["hover", "pageText", "waitFor"].includes(op)) focusFrame.set(tabId, where.frameId);
      return run(where.frameId, where.uid);
    }
    const frameId = op === "press" || op === "type" ? (focusFrame.get(tabId) ?? 0) : 0;
    // The remembered frame may be gone after a navigation; fall back to the top frame.
    return frameId ? run(frameId).catch(() => (focusFrame.delete(tabId), run(0))) : run(0);
  };
}

const METHODS: { [K in keyof ExtMethods]: (p: P, timeoutMs: number) => Promise<ExtMethods[K]["result"]> } = {
  /** Dev loop: a temporary add-on re-reads its files from disk; a signed install just restarts. */
  async reload() {
    setTimeout(() => browser.runtime.reload(), 150); // after the reply is on the wire
    return { reloading: true };
  },
  async listTabs() {
    const [tabs, win] = await Promise.all([browser.tabs.query({}), browser.windows.getLastFocused().catch(() => undefined)]);
    return Promise.all(tabs.map((t) => tabInfo(t, win?.id)));
  },
  async createTab(p, timeoutMs) {
    if (typeof p.url !== "string") throw fwError("BAD_PARAMS", "url (string) is required");
    return navigateWith(timeoutMs, p.wait, p.url, async () => (await browser.tabs.create({ url: p.url, active: true })).id!);
  },
  async navigate(p, timeoutMs) {
    const tabId = needTab(p);
    if (typeof p.url !== "string") throw fwError("BAD_PARAMS", "url (string) is required");
    await getTab(tabId);
    return navigateWith(timeoutMs, p.wait, p.url, async () => (await browser.tabs.update(tabId, { url: p.url }), tabId));
  },
  async history(p, timeoutMs) {
    const tabId = needTab(p);
    const delta = Number(p.delta);
    if (!Number.isInteger(delta) || delta === 0) throw fwError("BAD_PARAMS", "delta must be a non-zero integer (-1 back, +1 forward)");
    await getTab(tabId);
    const step = () => (delta < 0 ? browser.tabs.goBack(tabId) : browser.tabs.goForward(tabId));
    for (let i = 1; i < Math.abs(delta); i++) await step();
    return navigateWith(timeoutMs, p.wait, undefined, async () => (await step(), tabId));
  },
  async closeTab(p) {
    const tabId = needTab(p);
    await getTab(tabId);
    await browser.tabs.remove(tabId);
    return { closed: true as const };
  },
  snapshot,
  /** text/selector/change: poll every frame, first match wins; uid: only the uid's frame. */
  async waitFor(p, timeoutMs) {
    if (p.uid !== undefined) return (await action("waitFor")(p, timeoutMs)) as ExtMethods["waitFor"]["result"];
    const tabId = needTab(p);
    const replies = await everyFrame(tabId, "actions", { op: "waitFor", text: p.text, selector: p.selector, change: p.change }, timeoutMs, true);
    const hit = [...replies].find(([, x]) => x.ok);
    const r = hit?.[1] ?? replies.get(0);
    if (!r) throw fwError("TIMEOUT", `wait_for: no frame answered within ${timeoutMs} ms`);
    if (!r.ok) throw fwError(r.error.code, r.error.message, r.error.data);
    return { ...(r.result as ExtMethods["waitFor"]["result"]), ...(p.selector !== undefined && hit ? { frame: await frameLabel(tabId, hit[0]) } : {}) };
  },
  /** No selector: top frame body, or the uid's subtree. selector: every frame; the lowest frameId that matches wins. */
  async pageText(p, timeoutMs) {
    if (p.selector === undefined || p.uid !== undefined) return (await action("pageText")(p, timeoutMs)) as ExtMethods["pageText"]["result"];
    const tabId = needTab(p);
    const replies = await everyFrame(tabId, "actions", { op: "pageText", selector: p.selector, maxLength: p.maxLength }, timeoutMs);
    const hits = [...replies].filter(([, r]) => r.ok).sort(([a], [b]) => a - b);
    const top = replies.get(0);
    if (!hits.length && top && !top.ok && top.error.code !== "BAD_PARAMS") throw fwError(top.error.code, top.error.message, top.error.data);
    if (!hits.length) throw fwError("BAD_PARAMS", `CSS selector ${JSON.stringify(p.selector)} matched nothing in any frame`);
    const [frameId, r] = hits[0]!;
    return { ...((r as { result: ExtMethods["pageText"]["result"] }).result), frame: await frameLabel(tabId, frameId), otherFrames: hits.length - 1 };
  },
  ...(Object.fromEntries(ACTION_OPS.map((op) => [op, action(op)])) as { [K in (typeof ACTION_OPS)[number]]: never }),
  screenshot,
  async evaluate(p, timeoutMs) {
    const tabId = needTab(p);
    if (!settings.evaluateEnabled) throw fwError("DISABLED", "evaluate_script is switched off; enable it in the foxwire options page");
    if (typeof p.fn !== "string") throw fwError("BAD_PARAMS", "fn (string function expression) is required");
    return (await inject(tabId, "evaluate", { fn: p.fn, args: p.args, pageWorld: !!p.pageWorld }, { timeoutMs })) as { value: unknown };
  },
  async armDialog(p, timeoutMs) {
    const tabId = needTab(p);
    return (await inject(tabId, "dialog", { accept: !!p.accept, promptText: p.promptText, ttlMs: p.timeoutMs ?? 30_000 }, { timeoutMs })) as never;
  },
  status: extStatus,
  requestGrant,
};

// ---- wiring --------------------------------------------------------------------------------------

browser.tabs.onRemoved.addListener((tabId) => {
  clearTimeout(bubbles.get(tabId)?.timer);
  bubbles.delete(tabId);
  focusFrame.delete(tabId);
  frameAliases.delete(tabId);
  send({ event: "tab.removed", params: { tabId } });
});
browser.webNavigation.onCommitted.addListener((d) => void (d.frameId === 0 && frameAliases.delete(d.tabId)));
browser.permissions.onAdded.addListener(() => void Promise.all([sendStatus(), recheckAsks()]));
browser.permissions.onRemoved.addListener(() => void sendStatus());

browser.runtime.onMessage.addListener((msg: unknown, sender: browser.runtime.MessageSender) => {
  const fromExtPage = sender.id === browser.runtime.id && (sender.url ?? "").startsWith(browser.runtime.getURL(""));
  const type = fromExtPage ? (msg as { type?: unknown } | null)?.type : undefined;
  if (type === "fw.activity") return Promise.resolve(activity);
  if (type === "fw.pending") return Promise.resolve([...asks.values()].map(({ waiters: _w, drop: _d, ...a }) => a));
  if (type === "fw.deny") {
    const a = [...asks.values()].find((x) => x.id === (msg as { id?: unknown }).id);
    if (a) settleAsk(a, false);
    return Promise.resolve(!!a);
  }
  if (type !== "fw.status") return undefined;
  return Promise.resolve({
    ...state, port: settings.port ?? DEFAULT_PORT, hasSecret: !!settings.secret, evaluateEnabled: !!settings.evaluateEnabled,
  });
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  void loadSettings().then(() => {
    if ("secret" in changes || "port" in changes) {
      backoffMs = 1000;
      connect();
    }
    if ("evaluateEnabled" in changes || "bubbleEnabled" in changes) void sendStatus();
    if (!settings.bubbleEnabled) for (const tabId of [...bubbles.keys()]) void hideBubble(tabId);
  });
});

async function loadSettings(): Promise<void> {
  const s = (await browser.storage.local.get(["secret", "port", "evaluateEnabled", "bubbleEnabled"])) as Settings;
  settings = {
    secret: typeof s.secret === "string" && s.secret.trim() ? s.secret.trim() : undefined,
    port: Number.isInteger(s.port) && s.port! > 0 && s.port! < 65536 ? s.port : undefined,
    evaluateEnabled: s.evaluateEnabled === true,
    bubbleEnabled: s.bubbleEnabled !== false,
  };
}

void loadSettings().then(connect);
