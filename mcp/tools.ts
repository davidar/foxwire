// MCP tool surface (docs/DESIGN.md §5): JSON Schema definitions + handlers. Holds no browser state except
// this session's selected tab and the last `list_pages` listing (so idx → tabId is stable between calls).
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import {
  capIntent,
  fwError,
  isFwError,
  type ActionResult,
  type ExtMethod,
  type ExtMethods,
  type BrokerStatus,
  type TabInfo,
  type WaitUntil,
  type WithIntent,
} from "../shared/protocol.ts";
import { logPath } from "../broker/paths.ts";
import type { BrokerClient } from "./client.ts";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
  [k: string]: unknown;
}
type Schema = { type: string; description?: string; enum?: string[]; items?: Schema; minimum?: number; maximum?: number };
interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, Schema>; required?: string[]; additionalProperties: false };
  run: (a: Record<string, any>) => Promise<string | Content[]>;
}

const UPLOAD_CAP = 15 * 1024 * 1024;
const EVAL_CAP = 20_000;
const NAV_TIMEOUT_MS = 30_000;
const MIME: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  txt: "text/plain", csv: "text/csv", json: "application/json", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const HINTS: Record<string, () => string> = {
  NO_GRANT: () => "The user is asked automatically (foxwire toolbar popup) for a page's own site, so do not retry in a loop; tell them what you need. Other-site subframes and screenshots need grants in the foxwire options page",
  NOT_PAIRED: () => "Firefox running? foxwire extension installed with the secret pasted in its options? If the extension reloaded, uids from earlier snapshots are invalid: take_snapshot again",
  STALE_UID: () => "take_snapshot again and use a fresh uid",
  NO_BROKER: () => `see ${logPath()}`,
  TIMEOUT: () => "page may still be busy; retry or raise timeoutMs (wait_for change: nothing new yet, call again to keep waiting)",
  DISABLED: () => "enable evaluate_script in the extension options",
  NO_TAB: () => "list_pages then select_page",
};

// ---- schema helpers ----
const str = (description: string): Schema => ({ type: "string", description });
const int = (description: string, minimum?: number, maximum?: number): Schema => ({ type: "integer", description, minimum, maximum });
const bool = (description: string): Schema => ({ type: "boolean", description });
const strs = (description: string): Schema => ({ type: "array", items: { type: "string" }, description });
const waitS: Schema = { type: "string", enum: ["none", "interactive", "complete"], description: "how long to wait for the load (default: extension default)" };
const uidS = str("element uid from take_snapshot");
const saveS = str("absolute path to write the result to instead of returning it inline");
const intentS = str('brief first-person note of what you are doing and why, shown to the user in a thought bubble on the page, e.g. "Opening the March invoice to check the total"; under ~100 chars');
const NO_INTENT = new Set(["list_pages", "select_page", "close_page", "status", "sleep"]); // every other tool targets a tab

function validate(def: ToolDef, a: Record<string, unknown>): void {
  const { properties, required = [] } = def.inputSchema;
  for (const k of required) if (a[k] === undefined) throw fwError("BAD_PARAMS", `${def.name}: missing required "${k}"`);
  for (const [k, v] of Object.entries(a)) {
    const s = properties[k];
    if (!s) throw fwError("BAD_PARAMS", `${def.name}: unknown parameter "${k}"`);
    if (v === undefined) continue;
    const ok =
      s.type === "string" ? typeof v === "string" && (!s.enum || s.enum.includes(v))
      : s.type === "integer" ? Number.isInteger(v) && (s.minimum === undefined || (v as number) >= s.minimum) && (s.maximum === undefined || (v as number) <= s.maximum)
      : s.type === "boolean" ? typeof v === "boolean"
      : s.type === "array" ? Array.isArray(v) && (s.items?.type !== "string" || v.every((x) => typeof x === "string"))
      : s.type === "object" ? typeof v === "object" : true;
    if (!ok) throw fwError("BAD_PARAMS", `${def.name}: "${k}" must be ${s.enum ? `one of ${s.enum.join("|")}` : s.type}${s.type === "integer" && (s.minimum !== undefined || s.maximum !== undefined) ? ` in [${s.minimum ?? "-∞"}, ${s.maximum ?? "∞"}]` : ""}`);
  }
}

function writeFile(p: string, data: string | Buffer): string {
  if (!path.isAbsolute(p)) throw fwError("BAD_PARAMS", `saveTo must be an absolute path: ${p}`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

const line = (t: TabInfo, idx: number) => `[${idx}] ${t.title || "(untitled)"} — ${t.url}`;

export function createTools(client: BrokerClient) {
  let selected: number | null = null;
  let lastList: TabInfo[] = [];
  const ctx = new AsyncLocalStorage<{ notes: string[]; intent?: string }>(); // per call: prefix lines (auto-selection), intent

  client.onEvent((e) => {
    if (e.event === "tab.removed" && e.params?.tabId === selected) selected = null;
  });

  /** On NO_GRANT for a page's own origin, ask the user once (up to 60 s) and retry the call once if they allow it. */
  const request = async <R>(m: string, p: Record<string, unknown>): Promise<R> => {
    const intent = ctx.getStore()?.intent;
    const send = () => client.request<R>(m, intent ? { ...p, intent } : p);
    try {
      return await send();
    } catch (e) {
      const pattern = isFwError(e) && e.code === "NO_GRANT" ? (e.data as { pattern?: unknown } | undefined)?.pattern : undefined;
      if (typeof pattern !== "string" || pattern === "<all_urls>" || (p.tabId === undefined && p.url === undefined)) throw e;
      const where = p.tabId !== undefined ? { tabId: p.tabId } : { url: p.url };
      const g = await client.request<ExtMethods["requestGrant"]["result"]>("requestGrant", { ...where, ...(intent ? { intent } : {}), timeoutMs: 60_000 });
      ctx.getStore()?.notes.push(`note: the user granted ${g.pattern} when asked`);
      return send();
    }
  };
  const call = <M extends ExtMethod>(m: M, p: WithIntent<ExtMethods[M]["params"]>): Promise<ExtMethods[M]["result"]> =>
    request<ExtMethods[M]["result"]>(m, p as Record<string, unknown>);
  const listTabs = () => client.request<TabInfo[]>("listTabs", {});

  async function resolveTab(): Promise<number> {
    const tabs = await listTabs();
    if (selected !== null && tabs.some((t) => t.tabId === selected)) return selected;
    const pick = tabs.find((t) => t.windowFocused && t.active) ?? tabs.find((t) => t.active) ?? tabs[0];
    if (!pick) throw fwError("NO_TAB", "Firefox has no open tabs");
    selected = pick.tabId;
    ctx.getStore()?.notes.push(`auto-selected tab ${tabs.indexOf(pick)} ${pick.title || pick.url}`);
    return pick.tabId;
  }

  async function act(m: "click" | "hover" | "fill" | "type" | "press" | "selectOption" | "upload" | "armDialog", p: Record<string, unknown>): Promise<string> {
    const r = (await request<ActionResult>(m, { tabId: await resolveTab(), ...p })) ?? { ok: true };
    let out = r.note ?? `${m}: ok`;
    if (r.dialog) out += `\ndialog ${r.dialog.type} ${JSON.stringify(r.dialog.message)} → ${JSON.stringify(r.dialog.returned)}`;
    return out;
  }

  const tabLine = (t: TabInfo) => `${t.title || "(untitled)"} — ${t.url} (${t.status})`;

  async function shot(p: { fullPage?: boolean; uid?: string }, saveTo?: string): Promise<string | Content[]> {
    const r = await call("screenshot", { tabId: await resolveTab(), ...p });
    const b64 = r.dataUrl.replace(/^data:[^,]*,/, "");
    if (saveTo) return `saved ${writeFile(saveTo, Buffer.from(b64, "base64"))} (${r.width}x${r.height})`;
    return [{ type: "image", data: b64, mimeType: "image/png" }, { type: "text", text: `screenshot ${r.width}x${r.height}` }];
  }

  const defs: ToolDef[] = [];
  const tool = (name: string, description: string, properties: Record<string, Schema>, required: string[], run: ToolDef["run"]) => {
    if (!NO_INTENT.has(name)) properties = { ...properties, intent: intentS };
    defs.push({ name, description, inputSchema: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false }, run });
  };

  tool("list_pages", "List open Firefox tabs as [idx] title — url; idx is what select_page/close_page take (needs no site grant). filter keeps tabs whose title or url contains it; idx stays the full-listing index.", {
    filter: str("case-insensitive substring of title or url"),
  }, [], async (a) => {
    lastList = await listTabs();
    if (!lastList.length) return "no open tabs";
    const f = a.filter?.toLowerCase();
    const rows = lastList.map((t, i) => [t, i] as const).filter(([t]) => !f || `${t.title}\n${t.url}`.toLowerCase().includes(f));
    const out = rows.map(([t, i]) => line(t, i) + (t.active ? " (active)" : "") + (t.tabId === selected ? " (selected)" : ""));
    return (f === undefined ? out : [`${rows.length} of ${lastList.length} tabs match`, ...out]).join("\n");
  });

  tool("select_page", "Select the tab later calls act on, by exactly one of idx (from list_pages), tabId, or a case-insensitive url/title substring.", {
    idx: int("index from the last list_pages", 0), tabId: int("browser tab id"), url: str("substring of the tab URL"), title: str("substring of the tab title"),
  }, [], async (a) => {
    const given = ["idx", "tabId", "url", "title"].filter((k) => a[k] !== undefined);
    if (given.length !== 1) throw fwError("BAD_PARAMS", "select_page: pass exactly one of idx, tabId, url, title");
    const tabs = await listTabs();
    let hits: TabInfo[];
    if (a.idx !== undefined) {
      const src = lastList.length ? lastList : (lastList = tabs);
      const t = src[a.idx];
      if (!t) throw fwError("NO_TAB", `no tab at idx ${a.idx} in the last listing (${src.length} tabs)`);
      hits = tabs.filter((x) => x.tabId === t.tabId);
      if (!hits.length) throw fwError("NO_TAB", `tab [${a.idx}] ${t.title} has been closed`);
    } else if (a.tabId !== undefined) hits = tabs.filter((t) => t.tabId === a.tabId);
    else {
      const needle = String(a.url ?? a.title).toLowerCase();
      hits = tabs.filter((t) => (a.url !== undefined ? t.url : t.title).toLowerCase().includes(needle));
    }
    if (!hits.length) throw fwError("NO_TAB", `no tab matches ${JSON.stringify(a)}`);
    if (hits.length > 1) {
      throw fwError("BAD_PARAMS", `ambiguous: ${hits.length} tabs match; narrow it or use idx:\n` + hits.map((t) => line(t, tabs.indexOf(t))).join("\n"));
    }
    const t = hits[0]!;
    selected = t.tabId;
    const idx = lastList.findIndex((x) => x.tabId === t.tabId);
    return `selected ${line(t, idx >= 0 ? idx : tabs.indexOf(t))}`;
  });

  tool("new_page", "Open a new tab at url and select it.", { url: str("URL to open"), wait: waitS }, ["url"], async (a) => {
    const t = await call("createTab", { url: a.url, wait: a.wait as WaitUntil | undefined, timeoutMs: NAV_TIMEOUT_MS });
    selected = t.tabId;
    return `opened and selected tab ${t.tabId}: ${tabLine(t)}`;
  });

  tool("navigate_page", "Load url in the selected tab.", { url: str("URL to load"), wait: waitS }, ["url"], async (a) => {
    const t = await call("navigate", { tabId: await resolveTab(), url: a.url, wait: a.wait as WaitUntil | undefined, timeoutMs: NAV_TIMEOUT_MS });
    return `navigated: ${tabLine(t)}`;
  });

  tool("navigate_history", "Go back (delta -1) or forward (+1) in the selected tab's history.", { delta: int("history steps, e.g. -1 back, 1 forward") }, ["delta"], async (a) => {
    if (a.delta === 0) throw fwError("BAD_PARAMS", "navigate_history: delta must be non-zero");
    const t = await call("history", { tabId: await resolveTab(), delta: a.delta, timeoutMs: NAV_TIMEOUT_MS });
    return `now at: ${tabLine(t)}`;
  });

  tool("close_page", "Close the tab at idx from the last list_pages, or the selected tab if idx is omitted.", { idx: int("index from the last list_pages", 0) }, [], async (a) => {
    let tabId: number;
    if (a.idx !== undefined) {
      const t = lastList[a.idx];
      if (!t) throw fwError("NO_TAB", `no tab at idx ${a.idx} in the last listing; run list_pages`);
      tabId = t.tabId;
    } else {
      if (selected === null) throw fwError("NO_TAB", "no tab selected; pass idx");
      tabId = selected;
    }
    await call("closeTab", { tabId });
    lastList = lastList.filter((t) => t.tabId !== tabId);
    if (tabId === selected) selected = null;
    return `closed tab ${tabId}` + (selected === null ? " (no tab selected now)" : "");
  });

  tool("take_snapshot", "Text tree of the selected page (role, name, value, state) with uid=… on interactable elements (e.g. 12kqx; f2_12kqx inside iframe f2); uids survive re-snapshots until navigation or extension reload.", {
    selector: str("CSS selector to scope the walk (first match only)"), maxLines: int("lines to return inline (default 100)", 1), includeAll: bool("include hidden and non-interactive, unnamed nodes"), saveTo: saveS,
  }, [], async (a) => {
    const maxLines: number = a.maxLines ?? 100;
    const r = await call("snapshot", { tabId: await resolveTab(), selector: a.selector, includeAll: a.includeAll, maxNodes: a.saveTo ? 20_000 : Math.max(4000, maxLines * 4) });
    const out = [`${r.url} — ${r.title} (${r.lines.length} lines, ${r.frames} frames${r.truncated ? ", node cap hit: pass selector to see more" : ""})`];
    if (a.saveTo) return `${out[0]}\nfull tree (${r.lines.length} lines) saved to ${writeFile(a.saveTo, r.lines.join("\n") + "\n")}`;
    if (a.selector && !r.lines.length) out.push("(the matched element is hidden or empty; try a more specific selector, e.g. iframe[src*=…], or includeAll)");
    out.push(...r.lines.slice(0, maxLines));
    if (r.lines.length > maxLines) out.push(`… ${r.lines.length - maxLines} more lines — raise maxLines, pass selector, or saveTo a file`);
    return out.join("\n");
  });

  tool("get_page_text", "Visible text (innerText) of the selected page's top frame, or the full text of a uid's subtree or of a CSS selector's matches (searched in every frame, e.g. a chat widget's iframe).", {
    maxLength: int("max characters (default 20000)", 1), selector: str("CSS selector whose matches' text to return"), uid: uidS,
  }, [], async (a) => {
    if (a.selector !== undefined && a.uid !== undefined) throw fwError("BAD_PARAMS", "get_page_text: pass selector or uid, not both");
    const r = await call("pageText", { tabId: await resolveTab(), maxLength: a.maxLength ?? 20_000, selector: a.selector, uid: a.uid });
    const head = r.frame ? `matched ${r.matches} element(s) in ${r.frame}${r.otherFrames ? `; ${r.otherFrames} other frame(s) match too` : ""}\n` : "";
    return head + (r.length > r.text.length ? `${r.text}\n… truncated: ${r.text.length} of ${r.length} chars shown; raise maxLength` : r.text);
  });

  tool("click_by_uid", "Click an element (scrolls into view; synthetic events, isTrusted=false, so bot-check checkboxes need a human click).", { uid: uidS, dblClick: bool("double-click") }, ["uid"], (a) => act("click", { uid: a.uid, dblClick: a.dblClick }));
  tool("hover_by_uid", "Hover an element with synthetic pointer/mouse events.", { uid: uidS }, ["uid"], (a) => act("hover", { uid: a.uid }));
  tool("fill_by_uid", "Set a field's value (native setter + input/change events; checkbox/radio take true/false; editors that need real keystrokes: use type_text).", { uid: uidS, value: str("value to set") }, ["uid", "value"], (a) => act("fill", { uid: a.uid, value: a.value }));
  tool("type_text", "Type text key by key (keydown/keypress/input/keyup per char) into the uid, or the focused element if uid is omitted; submit presses Enter after it (send a chat message).", {
    text: str("text to type"), uid: uidS, submit: bool("press Enter in the same element after typing"),
  }, ["text"], (a) => act("type", { text: a.text, uid: a.uid, submit: a.submit }));
  tool("press_key", "Press a key (Enter, Tab, Escape, ArrowDown, a…) on the focused element, with optional modifiers (Control, Shift, Alt, Meta).", { key: str("KeyboardEvent.key value"), modifiers: strs("modifier keys held") }, ["key"], (a) => act("press", { key: a.key, modifiers: a.modifiers }));
  tool("select_option", "Choose option(s) of a <select> by value or visible label.", { uid: uidS, values: strs("option values or labels") }, ["uid", "values"], (a) => act("selectOption", { uid: a.uid, values: a.values }));

  tool("upload_file_by_uid", "Attach local files to an <input type=file> (files are read on this host; 15 MB total).", { uid: uidS, paths: strs("file paths, absolute or relative to the cwd") }, ["uid", "paths"], async (a) => {
    const paths = a.paths as string[];
    if (!paths.length) throw fwError("BAD_PARAMS", "upload_file_by_uid: paths is empty");
    let total = 0;
    const files = paths.map((p) => {
      const abs = path.resolve(p);
      let buf: Buffer;
      try {
        buf = fs.readFileSync(abs);
      } catch (e) {
        throw fwError("BAD_PARAMS", `cannot read ${abs}: ${(e as Error).message}`);
      }
      total += buf.length;
      if (total > UPLOAD_CAP) throw fwError("BAD_PARAMS", `files exceed the 15 MB upload cap (${total} bytes so far)`);
      const ext = path.extname(abs).slice(1).toLowerCase();
      return { name: path.basename(abs), type: MIME[ext] ?? "application/octet-stream", base64: buf.toString("base64") };
    });
    return act("upload", { uid: a.uid, files });
  });

  tool("screenshot_page", "PNG of the selected tab's viewport (or full page); returned inline unless saveTo is given.", { fullPage: bool("capture the whole scrollable page"), saveTo: saveS }, [], (a) => shot({ fullPage: a.fullPage }, a.saveTo));
  tool("screenshot_by_uid", "PNG of one element; returned inline unless saveTo is given.", { uid: uidS, saveTo: saveS }, ["uid"], (a) => shot({ uid: a.uid }, a.saveTo));

  tool("evaluate_script", "Run a JS function in the page and return its JSON result; OFF unless enabled in the extension options; pageWorld runs it as page JS (visible to the site).", {
    function: str("function source, e.g. \"(a, b) => document.title + a\""), args: { type: "array", description: "JSON arguments passed to the function" }, pageWorld: bool("run in the page world instead of the isolated sandbox"),
  }, ["function"], async (a) => {
    const r = await call("evaluate", { tabId: await resolveTab(), fn: a.function, args: a.args as unknown[] | undefined, pageWorld: a.pageWorld });
    const text = r.value === undefined ? "undefined" : (JSON.stringify(r.value, null, 2) ?? String(r.value));
    return text.length > EVAL_CAP ? `${text.slice(0, EVAL_CAP)}\n… truncated: ${text.length} chars total` : text;
  });

  tool("wait_for", "Wait until text, a CSS selector, or a uid is present in the selected page (polls in the page; default 10 s, max 60 s). With change: true, wait until the visible text of the selector/uid (or the whole page, or the tab title) changes and return what was added: use it for a chat reply, a list gaining a row, a spinner being replaced.", {
    text: str("visible text to wait for"), selector: str("CSS selector to wait for"), uid: uidS, timeoutMs: int("timeout in ms (default 10000)", 1, 60_000),
    change: bool("wait for the target's text to change (not combinable with text)"),
  }, [], async (a) => {
    if (a.change && a.text !== undefined) throw fwError("BAD_PARAMS", "wait_for: text and change are exclusive; use selector or uid to scope a change");
    if (!a.change && a.text === undefined && a.selector === undefined && a.uid === undefined) throw fwError("BAD_PARAMS", "wait_for: pass text, selector, uid or change");
    const r = await call("waitFor", { tabId: await resolveTab(), text: a.text, selector: a.selector, uid: a.uid, change: a.change, timeoutMs: a.timeoutMs ?? 10_000 });
    const where = r.matches !== undefined ? ` (${r.matches} match${r.matches === 1 ? "" : "es"}${r.frame ? `, ${r.frame}` : ""})` : "";
    const title = r.title !== undefined ? ` (title: ${JSON.stringify(r.title)})` : "";
    return a.change ? `changed after ${Math.round(r.elapsedMs)} ms${where}${title}:\n${r.added || "(no text added)"}` : `appeared after ${Math.round(r.elapsedMs)} ms${where}`;
  });

  tool("sleep", "Pause without touching the browser. To wait for the page, prefer wait_for (change: true for a reply you cannot predict).", { ms: int("milliseconds", 1, 60_000) }, ["ms"], async (a) => {
    await new Promise((r) => setTimeout(r, a.ms));
    return `slept ${a.ms} ms`;
  });

  tool("handle_dialog", "Pre-arm the answer for the next alert/confirm/prompt the page opens during the following call (then restored).", { accept: bool("accept (OK) or dismiss (Cancel)"), promptText: str("text to return from prompt()") }, ["accept"], (a) => act("armDialog", { accept: a.accept, promptText: a.promptText }));

  tool("status", "Health check: broker, pairing, extension/Firefox versions, site grants, evaluate_script and thought-bubble switches, selected tab.", {}, [], async () => {
    const b = await client.request<BrokerStatus>("broker.status", {});
    const out = [`paired: ${b.paired ? "yes" : "no"}`, `broker: pid ${b.brokerPid}, port ${b.port}, ${b.clients} client(s), log ${logPath()}`];
    if (!b.paired) {
      out.push(`not paired: ${HINTS.NOT_PAIRED!()}`);
    } else {
      try {
        const s = await call("status", {});
        out.push(`extension ${s.extensionVersion} on Firefox ${s.firefoxVersion}`, `evaluateEnabled: ${s.evaluateEnabled}`, `bubbleEnabled: ${s.bubbleEnabled}`);
        out.push(s.grants.length ? "grants:" : "grants: none", ...s.grants.map((g) => `  ${g}`));
        if (s.asking?.length) out.push(`asking the user for: ${s.asking.join(", ")}`);
      } catch (e) {
        out.push(`extension status failed: ${isFwError(e) ? `${e.code}: ${e.message}` : String(e)}`);
      }
      try {
        const tabs = await listTabs();
        const t = tabs.find((x) => x.tabId === selected);
        out.push(`selected tab: ${t ? line(t, tabs.indexOf(t)) : "none"}`);
      } catch {
        out.push(`selected tab: ${selected ?? "none"}`);
      }
    }
    return out.join("\n");
  });

  const byName = new Map(defs.map((d) => [d.name, d]));

  async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const store = ctx.getStore()!;
    const pre = store.notes;
    try {
      const def = byName.get(name);
      if (!def) throw fwError("BAD_PARAMS", `unknown tool ${name}`);
      validate(def, args);
      if (typeof args.intent === "string" && args.intent.trim()) store.intent = capIntent(args.intent.trim());
      const r = await def.run(args);
      const content: Content[] = typeof r === "string" ? [{ type: "text", text: r }] : r;
      if (pre.length) content.unshift({ type: "text", text: pre.join("\n") });
      return { content };
    } catch (e) {
      let text: string;
      if (isFwError(e)) {
        text = `${e.code}: ${e.message}`;
        const hint = HINTS[e.code];
        if (hint) text += `\nhint: ${hint()}`;
        if (e.data !== undefined) text += `\ndata: ${JSON.stringify(e.data)}`;
      } else text = `INTERNAL: ${e instanceof Error ? e.message : String(e)}`;
      if (pre.length) text = pre.join("\n") + "\n" + text;
      return { content: [{ type: "text", text }], isError: true };
    }
  }

  return {
    list: () => defs.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    call: (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => ctx.run({ notes: [] }, () => callTool(name, args)),
  };
}
