// Wire protocol shared by extension, broker and mcp. See docs/DESIGN.md §4.
// JSON text frames; one request → one response correlated by `id`; events carry no `id`.

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 47777;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 60_000;

/** Named error codes. Every failure the user can see carries one of these; never a bare "unknown error". */
export const ERROR_CODES = [
  "NO_GRANT", // no host permission for the tab's origin — the user is asked via the toolbar popup, or grants it in the options
  "NO_TAB", // tab id does not exist (closed) or no tab selected
  "STALE_UID", // uid unknown, its element left the DOM, or it is from an older registry (reload/navigation)
  "TIMEOUT", // the browser did not answer within the call's timeout
  "INJECT_FAILED", // executeScript refused (privileged page, CSP) or the injected code threw
  "NOT_PAIRED", // broker is up but no authenticated extension is connected
  "DISABLED", // tool is switched off in the extension options (evaluate_script)
  "NO_BROKER", // mcp could not reach or start the broker
  "BAD_PARAMS", // params failed validation
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface FwError {
  code: ErrorCode;
  message: string;
  data?: unknown;
}

export interface RequestFrame {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}
export interface ResponseFrame {
  id: number;
  result?: unknown;
  error?: FwError;
}
export interface EventFrame {
  event: string;
  params?: Record<string, unknown>;
}
export type Frame = RequestFrame | ResponseFrame | EventFrame;

export function isRequest(f: Frame): f is RequestFrame {
  return "id" in f && "method" in f && typeof (f as RequestFrame).method === "string";
}
export function isResponse(f: Frame): f is ResponseFrame {
  return "id" in f && !("method" in f);
}
export function isEvent(f: Frame): f is EventFrame {
  return "event" in f && !("id" in f);
}

/** Parse one text frame; returns null (never throws) on garbage. */
export function parseFrame(text: string): Frame | null {
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object") return null;
    if ("event" in v && typeof v.event === "string") return v as EventFrame;
    if (typeof v.id === "number") return v as RequestFrame | ResponseFrame;
    return null;
  } catch {
    return null;
  }
}

export class FwErrorImpl extends Error implements FwError {
  code: ErrorCode;
  data?: unknown;
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "FwError";
    this.code = code;
    this.data = data;
  }
  toJSON(): FwError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}
export function fwError(code: ErrorCode, message: string, data?: unknown): FwErrorImpl {
  return new FwErrorImpl(code, message, data);
}
/**
 * Snapshot uid: `<n><tag>` in the top frame ("37kqx"), `f<k>_<n><tag>` in a subframe ("f2_37kqx"), where k is the
 * background's per-tab frame alias (1, 2, … in first-seen order). The 3-letter tag is the generation of the frame's
 * uid registry, so a uid from before a reload or navigation fails with STALE_UID instead of resolving to whatever
 * element now holds that number. A tagless "37" parses too and is reported stale. frame 0 = top frame.
 */
export function parseUid(uid: unknown): { frame: number; uid: string } {
  const s = String(uid ?? "");
  const m = /^(?:f([1-9]\d*)_)?(\d+[a-z]{0,3})$/.exec(s);
  if (!m) throw fwError("BAD_PARAMS", `uid ${JSON.stringify(s)} is not a snapshot uid (e.g. 12kqx or f2_12kqx)`);
  return { frame: Number(m[1] ?? 0), uid: m[2]! };
}
export function isFwError(e: unknown): e is FwError {
  return (
    !!e &&
    typeof e === "object" &&
    typeof (e as FwError).code === "string" &&
    (ERROR_CODES as readonly string[]).includes((e as FwError).code) &&
    typeof (e as FwError).message === "string"
  );
}

// ---- Handshake (extension ↔ broker), carried as events --------------------------------------

export interface HelloParams {
  nonce: string; // hex
  protocol: number;
}
export interface AuthParams {
  hmac: string; // hex HMAC-SHA256(secret, nonce)
  extensionVersion: string;
  firefoxVersion: string;
}

// ---- Methods served by the extension ---------------------------------------------------------

export type WaitUntil = "none" | "interactive" | "complete";

export interface TabInfo {
  tabId: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  active: boolean; // active tab of its window
  windowFocused: boolean; // its window is the focused one (default-selection hint for the mcp)
  status: string;
}

export interface SnapshotResult {
  url: string;
  title: string;
  lines: string[];
  frames: number;
  truncated: boolean;
}

export interface UploadFile {
  name: string;
  type: string;
  base64: string;
}

export interface ScreenshotResult {
  dataUrl: string; // image/png
  width: number;
  height: number;
}

export interface ExtStatus {
  extensionVersion: string;
  firefoxVersion: string;
  grants: string[];
  evaluateEnabled: boolean;
  bubbleEnabled: boolean;
  asking?: string[]; // patterns the user is being asked to grant right now
}

/** Any tab-targeting request may carry `intent`: Claude's note for the on-page thought bubble and the toolbar popup. */
export type WithIntent<T> = T & { intent?: string };
export const INTENT_MAX = 200;
export const capIntent = (s: string): string => (s.length > INTENT_MAX ? s.slice(0, INTENT_MAX - 1) + "…" : s);

/** Method name → { params, result }. The broker forwards these verbatim. Params also accept WithIntent. */
export interface ExtMethods {
  listTabs: { params: Record<string, never>; result: TabInfo[] };
  createTab: { params: { url: string; wait?: WaitUntil; timeoutMs?: number }; result: TabInfo };
  navigate: { params: { tabId: number; url: string; wait?: WaitUntil; timeoutMs?: number }; result: TabInfo };
  history: { params: { tabId: number; delta: number; wait?: WaitUntil; timeoutMs?: number }; result: TabInfo };
  closeTab: { params: { tabId: number }; result: { closed: true } };
  snapshot: {
    params: { tabId: number; selector?: string; includeAll?: boolean; maxNodes?: number; timeoutMs?: number };
    result: SnapshotResult;
  };
  pageText: {
    params: { tabId: number; maxLength?: number; selector?: string; uid?: string; timeoutMs?: number };
    /** frame/otherFrames only with selector: where the text came from, and how many other frames also matched. */
    result: { text: string; length: number; matches?: number; frame?: string; otherFrames?: number };
  };
  click: { params: { tabId: number; uid: string; dblClick?: boolean; timeoutMs?: number }; result: ActionResult };
  hover: { params: { tabId: number; uid: string; timeoutMs?: number }; result: ActionResult };
  fill: { params: { tabId: number; uid: string; value: string; timeoutMs?: number }; result: ActionResult };
  type: { params: { tabId: number; text: string; uid?: string; submit?: boolean; timeoutMs?: number }; result: ActionResult };
  press: { params: { tabId: number; key: string; modifiers?: string[]; timeoutMs?: number }; result: ActionResult };
  selectOption: { params: { tabId: number; uid: string; values: string[]; timeoutMs?: number }; result: ActionResult };
  upload: { params: { tabId: number; uid: string; files: UploadFile[]; timeoutMs?: number }; result: ActionResult };
  screenshot: { params: { tabId: number; fullPage?: boolean; uid?: string; timeoutMs?: number }; result: ScreenshotResult };
  evaluate: {
    params: { tabId: number; fn: string; args?: unknown[]; pageWorld?: boolean; timeoutMs?: number };
    result: { value: unknown };
  };
  waitFor: {
    params: { tabId: number; text?: string; selector?: string; uid?: string; change?: boolean; timeoutMs?: number };
    /** matches/frame with a selector; title (top frame, change mode) is document.title when it resolved. */
    result: { elapsedMs: number; added?: string; title?: string; matches?: number; frame?: string };
  };
  armDialog: { params: { tabId: number; accept: boolean; promptText?: string; timeoutMs?: number }; result: ActionResult };
  status: { params: Record<string, never>; result: ExtStatus };
  reload: { params: Record<string, never>; result: { reloading: true } };
  /** Ask the user (toolbar popup → Firefox's own prompt) for the one origin pattern of tabId/url; NO_GRANT if they decline or does not answer. */
  requestGrant: { params: { tabId?: number; url?: string; timeoutMs?: number }; result: { granted: true; pattern: string } };
}
export type ExtMethod = keyof ExtMethods;

/** What an action returns: a one-line description plus any dialog an armed handler swallowed. */
export interface ActionResult {
  ok: true;
  note?: string;
  dialog?: { type: "alert" | "confirm" | "prompt"; message: string; returned: unknown };
}

// ---- Methods served by the broker itself -------------------------------------------------------

export interface BrokerStatus {
  paired: boolean;
  extension?: { extensionVersion: string; firefoxVersion: string; connectedAt: string };
  clients: number;
  secretPath: string;
  port: number;
  brokerPid: number;
}
export interface BrokerMethods {
  "broker.status": { params: Record<string, never>; result: BrokerStatus };
  "broker.clients": { params: Record<string, never>; result: { id: number; connectedAt: string; pending: number }[] };
}

// ---- Events ----------------------------------------------------------------------------------

export interface Events {
  "ext.connected": ExtStatus;
  "ext.disconnected": { reason: string };
  "tab.updated": { tabId: number; status?: string; url?: string; title?: string };
  "tab.removed": { tabId: number };
}
