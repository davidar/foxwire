// Shared helpers for injected bundles. Everything here runs in the extension's content-script sandbox
// (isolated world): `globalThis` is the sandbox global, invisible to page scripts. docs/DESIGN.md §6–§7.
import type { ErrorCode } from "../../shared/protocol.ts";

declare global {
  // Firefox content-script globals (no @types entry); used only by dialog.ts and evaluate.ts.
  function exportFunction(fn: Function, scope: object, options?: { defineAs?: string }): any;
  function cloneInto<T>(obj: T, scope: object, options?: { cloneFunctions?: boolean; wrapReflectors?: boolean }): T;
  interface Window {
    /** Firefox content-script escape hatch to the page world. Used only by dialog.ts and evaluate.ts. */
    wrappedJSObject: Window & Record<string, any>;
  }
}

export interface CallArgs {
  __call: string;
  timeoutMs?: number;
  [k: string]: unknown;
}

export class InjectError extends Error {
  code: ErrorCode;
  data?: unknown;
  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export function getArgs<T extends object>(): T & CallArgs {
  const g = globalThis as unknown as { __fw_args?: T & CallArgs };
  const a = g.__fw_args;
  if (!a) throw new InjectError("INJECT_FAILED", "injected without arguments");
  delete g.__fw_args;
  return a;
}

/** Deliver the call's outcome to the background script, then clean up. */
export function run<T extends object>(body: (args: T & CallArgs) => unknown | Promise<unknown>): void {
  // Read args synchronously, in the same script evaluation that set them, so back-to-back injections
  // from two sessions can never see each other's arguments.
  let call = "";
  let args: (T & CallArgs) | undefined;
  try {
    args = getArgs<T>();
    call = args.__call;
  } catch {
    return; // nothing to report to and nobody waiting
  }
  Promise.resolve()
    .then(() => body(args!))
    .then(
      (result) => browser.runtime.sendMessage({ __fw: call, ok: true, result: result ?? null }),
      (e: unknown) => {
        const err =
          e instanceof InjectError
            ? { code: e.code, message: e.message, data: e.data }
            : { code: "INJECT_FAILED" as ErrorCode, message: (e as Error)?.message ?? String(e) };
        return browser.runtime.sendMessage({ __fw: call, ok: false, error: err });
      },
    )
    .catch(() => {});
}

// ---- uid registry (sandbox-only, survives across calls until navigation) ------------------

interface Registry {
  byId: Map<number, WeakRef<Element>>;
  byEl: WeakMap<Element, number>;
  next: number;
  /** Generation: a fresh registry (extension reload, new document) gets a new tag; uids carry it (parseUid). */
  tag: string;
}
function registry(): Registry {
  const g = globalThis as unknown as { __fw_uids?: Registry };
  const tag = () => Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => String.fromCharCode(97 + (b % 26))).join("");
  return (g.__fw_uids ??= { byId: new Map(), byEl: new WeakMap(), next: 1, tag: tag() });
}
export function uidFor(el: Element): string {
  const r = registry();
  let id = r.byEl.get(el);
  if (id === undefined) {
    id = r.next++;
    r.byEl.set(el, id);
    r.byId.set(id, new WeakRef(el));
  }
  return `${id}${r.tag}`;
}
export function elementFor(uid: string): Element {
  const r = registry();
  const m = /^(\d+)([a-z]*)$/.exec(uid);
  if (m?.[2] !== r.tag) {
    throw new InjectError("STALE_UID", `uid ${uid} is from an earlier snapshot: the page or the extension reloaded since; take_snapshot again`, { reloaded: true });
  }
  const el = r.byId.get(Number(m[1]))?.deref();
  if (!el || !el.isConnected) {
    throw new InjectError("STALE_UID", `uid ${uid} is unknown or its element left the page; take_snapshot again`);
  }
  return el;
}

/** Visible text with whitespace collapsed per line and blank lines dropped; undefined for no element. */
export function visibleText(el: Element | null | undefined): string | undefined {
  const t = (el as HTMLElement | null)?.innerText ?? el?.textContent;
  return t == null ? undefined : t.split("\n").map((l) => collapse(l, Infinity)).filter(Boolean).join("\n");
}

/** What changed from old to new text: the appended suffix, else the new lines absent from old; capped. */
export function textDelta(old: string, now: string, cap = 2000): string {
  const seen = new Set(old.split("\n"));
  const d = now.startsWith(old) ? now.slice(old.length) : now.split("\n").filter((l) => !seen.has(l)).join("\n");
  return d.trim().length > cap ? d.trim().slice(0, cap - 1) + "…" : d.trim();
}

// ---- DOM helpers ---------------------------------------------------------------------------

export function shadowRootOf(el: Element): ShadowRoot | null {
  return (el as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot ?? el.shadowRoot;
}

/** Deepest focused element, descending through shadow roots. */
export function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  for (;;) {
    const root = el && shadowRootOf(el);
    if (!root?.activeElement) return el;
    el = root.activeElement;
  }
}

export function isEditable(el: Element | null): el is HTMLElement {
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !el.readOnly && !el.disabled && !["checkbox", "radio", "button", "submit", "reset", "file", "image", "range", "color", "hidden"].includes(el.type);
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  return (el as HTMLElement).isContentEditable === true;
}

export function collapse(s: string | null | undefined, max = 80): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

export function describe(el: Element): string {
  const id = el.id ? `#${el.id}` : "";
  const name = el.getAttribute("aria-label") ?? el.getAttribute("name") ?? "";
  return `<${el.tagName.toLowerCase()}${id}${name ? ` "${collapse(name, 30)}"` : ""}>`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pop the dialog an earlier arm_dialog swallowed, if any (see dialog.ts). */
export function takeDialog(): { type: "alert" | "confirm" | "prompt"; message: string; returned: unknown } | undefined {
  const g = globalThis as unknown as { __fw_dialog?: { fired?: { type: "alert" | "confirm" | "prompt"; message: string; returned: unknown } } };
  const fired = g.__fw_dialog?.fired;
  if (fired && g.__fw_dialog) delete g.__fw_dialog.fired;
  return fired;
}

// ---- synthetic events ----------------------------------------------------------------------

export interface Mods {
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

export function mouseEvent(el: Element, type: string, extra: MouseEventInit = {}): boolean {
  const r = el.getBoundingClientRect();
  const init: MouseEventInit & { pointerId?: number; pointerType?: string; isPrimary?: boolean } = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    button: 0,
    buttons: type.endsWith("down") ? 1 : 0,
    ...extra,
  };
  if (type.startsWith("pointer")) {
    init.pointerId = 1;
    init.pointerType = "mouse";
    init.isPrimary = true;
    return el.dispatchEvent(new PointerEvent(type, init));
  }
  return el.dispatchEvent(new MouseEvent(type, init));
}

const KEYCODES: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27, " ": 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Delete: 46, Meta: 91,
};
export function keyCodeFor(key: string): number {
  if (KEYCODES[key] !== undefined) return KEYCODES[key]!;
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  const f = /^F(\d{1,2})$/.exec(key);
  return f ? 111 + Number(f[1]) : 0;
}
export function codeFor(key: string): string {
  if (key === " ") return "Space";
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key;
}

/** Fire keydown/keypress/keyup like a real keystroke; returns false if the page cancelled keydown or keypress. */
export function keyEvent(el: Element, type: "keydown" | "keypress" | "keyup", key: string, mods: Mods = {}): boolean {
  const init: KeyboardEventInit & { keyCode?: number; charCode?: number; which?: number } = {
    key,
    code: codeFor(key),
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    ...mods,
  };
  if (type === "keypress" && key.length === 1) {
    init.charCode = key.charCodeAt(0);
    init.keyCode = key.charCodeAt(0);
    init.which = key.charCodeAt(0);
  } else {
    init.keyCode = keyCodeFor(key);
    init.which = init.keyCode;
  }
  return el.dispatchEvent(new KeyboardEvent(type, init));
}

export function inputEvent(el: Element, inputType: string, data: string | null = null): void {
  el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data }));
}
export function changeEvent(el: Element): void {
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Insert text at the caret of the focused editable, the way a keystroke would. */
export function insertText(el: HTMLElement, text: string): void {
  if (document.execCommand("insertText", false, text)) return; // fires a real `input` event
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
    } catch {
      el.value += text;
    }
    inputEvent(el, "insertText", text);
  } else {
    el.textContent = (el.textContent ?? "") + text;
    inputEvent(el, "insertText", text);
  }
}

export function scrollIntoViewIfNeeded(el: Element): void {
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
    el.scrollIntoView({ block: "center", inline: "nearest" });
  }
}
