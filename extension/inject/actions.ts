// Element actions, keyed by `op`. One bundle, one injection per tool call. docs/DESIGN.md §5.
// All events are synthetic (isTrusted=false) — the same limitation as every extension-based driver.
import type { ActionResult } from "../../shared/protocol.ts";
import {
  InjectError, changeEvent, collapse, deepActiveElement, describe, elementFor, inputEvent, insertText,
  isEditable, keyEvent, mouseEvent, run, scrollIntoViewIfNeeded, sleep, takeDialog, textDelta, visibleText, type Mods,
} from "./lib.ts";

type Args =
  | { op: "click"; uid: string; dblClick?: boolean }
  | { op: "hover"; uid: string }
  | { op: "fill"; uid: string; value: string }
  | { op: "type"; text: string; uid?: string; submit?: boolean }
  | { op: "press"; key: string; modifiers?: string[] }
  | { op: "selectOption"; uid: string; values: string[] }
  | { op: "upload"; uid: string; files: { name: string; type: string; base64: string }[] }
  | { op: "waitFor"; text?: string; selector?: string; uid?: string; change?: boolean; timeoutMs?: number; requestedMs?: number }
  | { op: "pageText"; maxLength?: number; selector?: string; uid?: string }
  | { op: "rect"; uid?: string; fullPage?: boolean; viewport?: boolean };

function focus(el: Element): void {
  (el as HTMLElement).focus?.({ preventScroll: true });
}

function click(el: Element, dbl: boolean): void {
  scrollIntoViewIfNeeded(el);
  const rounds = dbl ? 2 : 1;
  for (let i = 0; i < rounds; i++) {
    mouseEvent(el, "pointerover");
    mouseEvent(el, "mouseover");
    mouseEvent(el, "pointerdown");
    const goOn = mouseEvent(el, "mousedown");
    if (goOn) focus(el);
    mouseEvent(el, "pointerup");
    mouseEvent(el, "mouseup");
    if (el instanceof HTMLElement || el instanceof SVGElement) (el as HTMLElement).click();
    else mouseEvent(el, "click", { detail: i + 1 });
  }
  if (dbl) mouseEvent(el, "dblclick", { detail: 2 });
}

/** Focus a field the way a user does, by clicking it, unless it already has focus (a click could move the caret). */
function clickToFocus(el: Element): void {
  scrollIntoViewIfNeeded(el);
  if (deepActiveElement() === el) return;
  click(el, false);
  const now = deepActiveElement();
  if (!now || !el.contains(now)) focus(el); // mousedown was cancelled, or focus did not land inside the target
}

function hover(el: Element): void {
  scrollIntoViewIfNeeded(el);
  for (const t of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) mouseEvent(el, t);
}

function fill(el: Element, value: string): string {
  if (el instanceof HTMLSelectElement) return selectOption(el, [value]);
  const d = describe(el); // before any event: handlers may rename or re-id the element
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
    const want = ["true", "1", "on", "yes", "checked"].includes(value.toLowerCase());
    if (el.checked !== want) click(el, false);
    return `${d} ${el.checked ? "checked" : "unchecked"}`;
  }
  if (!isEditable(el)) {
    const why = el.matches(":disabled") ? "is disabled" : (el as HTMLInputElement).readOnly ? "is readonly" : "is not an editable field; use click_by_uid or select_option";
    throw new InjectError("BAD_PARAMS", `${d} ${why}`);
  }
  clickToFocus(el);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const textLike = el instanceof HTMLTextAreaElement || ["text", "search", "url", "tel", "email", "password", ""].includes(el.type);
    if (textLike) {
      el.select();
      if (document.execCommand("insertText", false, value) && el.value === value) {
        changeEvent(el);
        return `filled ${d}`;
      }
    }
    el.value = value; // Xray → native setter; React's own-property tracker is bypassed, so the input event is honoured
    inputEvent(el, "insertReplacementText", value);
    changeEvent(el);
    return `filled ${d}${el.value !== value ? ` (field normalised it to ${JSON.stringify(el.value)})` : ""}`;
  }
  // contenteditable
  const sel = el.ownerDocument.getSelection();
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  sel?.removeAllRanges();
  sel?.addRange(range);
  if (!document.execCommand("insertText", false, value)) {
    el.textContent = value;
    inputEvent(el, "insertReplacementText", value);
  }
  return `filled ${d} (contenteditable)`;
}

/** A <label>, or something inside one, stands for its control (label.control: `for=` or the labelable descendant). */
function controlOf(el: Element): Element {
  return el.matches("input,textarea,select,[contenteditable]") ? el : (el.closest("label")?.control ?? el);
}

/** The link a click on el follows, if it opens a new browsing context (target, else <base target>). */
function newTabLink(el: Element): HTMLAnchorElement | HTMLAreaElement | null {
  const link = el.closest<HTMLAnchorElement | HTMLAreaElement>("a[href],area[href]");
  const target = link?.getAttribute("target") ?? document.querySelector("base[target]")?.getAttribute("target") ?? "";
  return link && !["", "_self", "_parent", "_top"].includes(target.toLowerCase()) ? link : null;
}

function typeText(target: Element | null, text: string): string {
  const before = target && describe(target); // before the focusing click can re-label it
  if (target) clickToFocus(target);
  let el = deepActiveElement() ?? target;
  if (!el) throw new InjectError("BAD_PARAMS", "nothing is focused; pass a uid");
  const d = before || describe(el);
  let typed = 0;
  for (const ch of text) {
    el = deepActiveElement() ?? el; // focus may move (e.g. auto-advancing date fields)
    const key = ch === "\n" ? "Enter" : ch;
    if (keyEvent(el, "keydown", key) && keyEvent(el, "keypress", key)) {
      if (key === "Enter") pressEnter(el);
      else if (isEditable(el)) insertText(el, ch);
    }
    keyEvent(el, "keyup", key);
    typed++;
  }
  return `typed ${typed} chars into ${d}`;
}

function pressEnter(el: Element): void {
  if (el instanceof HTMLTextAreaElement) return insertText(el, "\n");
  if ((el as HTMLElement).isContentEditable) {
    if (!document.execCommand("insertParagraph")) insertText(el as HTMLElement, "\n");
    return;
  }
  if (el instanceof HTMLInputElement && el.form) {
    const btn = el.form.querySelector<HTMLElement>('button:not([type=button]):not([type=reset]),input[type=submit],input[type=image]');
    if (btn) btn.click();
    else el.form.requestSubmit();
  } else if (el instanceof HTMLElement && (el.tagName === "BUTTON" || el.tagName === "A" || el.getAttribute("role") === "button")) {
    el.click();
  }
}

const FOCUSABLE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[tabindex]:not([tabindex="-1"]),[contenteditable]:not([contenteditable="false"])';
function moveFocus(from: Element | null, backwards: boolean): Element | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => {
    if ((e as HTMLButtonElement).disabled) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  if (!all.length) return null;
  const i = from ? all.indexOf(from as HTMLElement) : -1;
  const next = all[(i + (backwards ? -1 : 1) + all.length) % all.length] ?? all[0]!;
  next.focus();
  return next;
}

function press(key: string, modifiers: string[]): string {
  const mods: Mods = {
    ctrlKey: modifiers.includes("Control") || modifiers.includes("Ctrl"),
    shiftKey: modifiers.includes("Shift"),
    altKey: modifiers.includes("Alt"),
    metaKey: modifiers.includes("Meta"),
  };
  const el = deepActiveElement() ?? document.body;
  const plain = !mods.ctrlKey && !mods.altKey && !mods.metaKey;
  let note = `pressed ${modifiers.length ? modifiers.join("+") + "+" : ""}${key} on ${describe(el)}`;
  const down = keyEvent(el, "keydown", key, mods);
  const pressOk = down && (key.length === 1 || key === "Enter") ? keyEvent(el, "keypress", key, mods) : down;
  if (pressOk && plain) {
    if (key === "Enter") pressEnter(el);
    else if (key === "Tab") note += ` → focus ${describe(moveFocus(el, !!mods.shiftKey) ?? el)}`;
    else if (key === " " && (el.tagName === "BUTTON" || (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")))) (el as HTMLElement).click();
    else if (isEditable(el)) {
      if (key === "Backspace") document.execCommand("delete");
      else if (key === "Delete") document.execCommand("forwardDelete");
      else if (key.length === 1) insertText(el, key);
      else if (key === "Home" || key === "End") {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const p = key === "Home" ? 0 : el.value.length;
          el.setSelectionRange(p, p);
        }
      }
    }
  } else if (pressOk && mods.ctrlKey && !mods.altKey && !mods.metaKey && isEditable(el) && key.toLowerCase() === "a") {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
    else document.execCommand("selectAll");
  }
  keyEvent(el, "keyup", key, mods);
  return note;
}

function selectOption(el: Element, values: string[]): string {
  if (!(el instanceof HTMLSelectElement)) throw new InjectError("BAD_PARAMS", `${describe(el)} is not a <select>`);
  const opts = Array.from(el.options);
  const matches = (o: HTMLOptionElement, v: string) => o.value === v || collapse(o.textContent) === v || o.label === v;
  const picked = new Set<HTMLOptionElement>();
  for (const v of values) {
    const o = opts.find((o) => matches(o, v)) ?? opts.find((o) => collapse(o.textContent).toLowerCase() === v.toLowerCase());
    if (o) picked.add(o);
  }
  if (!picked.size) {
    throw new InjectError("BAD_PARAMS", `no option matches ${JSON.stringify(values)}`, {
      options: opts.slice(0, 50).map((o) => ({ value: o.value, text: collapse(o.textContent) })),
    });
  }
  const d = describe(el);
  scrollIntoViewIfNeeded(el);
  focus(el);
  const before = Array.from(el.selectedOptions).map((o) => o.value).join("\u0000");
  if (el.multiple) for (const o of opts) o.selected = picked.has(o);
  else el.selectedIndex = opts.indexOf([...picked][0]!);
  const after = Array.from(el.selectedOptions).map((o) => o.value).join("\u0000");
  if (before !== after) {
    inputEvent(el, "insertReplacementText");
    changeEvent(el);
  }
  return `selected ${[...picked].map((o) => JSON.stringify(collapse(o.textContent))).join(", ")} in ${d}${before === after ? " (unchanged)" : ""}`;
}

function upload(el: Element, files: { name: string; type: string; base64: string }[]): string {
  if (!(el instanceof HTMLInputElement) || el.type !== "file") throw new InjectError("BAD_PARAMS", `${describe(el)} is not an <input type=file>`);
  if (files.length > 1 && !el.multiple) throw new InjectError("BAD_PARAMS", `${describe(el)} accepts a single file`);
  const d = describe(el);
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }));
  }
  el.files = dt.files;
  inputEvent(el, "insertFromPaste");
  changeEvent(el);
  return `set ${el.files?.length ?? 0} file(s) on ${d}: ${files.map((f) => f.name).join(", ")}`;
}

async function waitFor(a: { text?: string; selector?: string; uid?: string; change?: boolean; timeoutMs?: number; requestedMs?: number }): Promise<{ elapsedMs: number; added?: string }> {
  const start = performance.now();
  const limit = Math.min(a.timeoutMs ?? 10_000, 60_000) - 250; // leave headroom for the background's own timer
  // change: the target's visible text (per line, whitespace collapsed); undefined while the target is absent.
  const textNow = () => visibleText(a.uid ? elementFor(a.uid) : a.selector ? document.querySelector(a.selector) : document.body);
  const before = a.change ? textNow() : undefined;
  const top = window.top === window; // the top frame's title change also counts (e.g. "New message from …")
  const title = document.title;
  const check = (): boolean => {
    if (a.change) {
      const now = textNow();
      return (now !== undefined && now !== before) || (top && document.title !== title);
    }
    if (a.selector && !document.querySelector(a.selector)) return false;
    if (a.text && !(document.body?.innerText ?? "").includes(a.text)) return false;
    if (a.uid) {
      try {
        const el = elementFor(a.uid);
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
      } catch (e) {
        if ((e as InjectError).data) throw e; // uid from an older registry: it can never appear
        return false;
      }
    }
    return true;
  };
  for (;;) {
    if (check()) {
      const r: { elapsedMs: number; added?: string; title?: string; matches?: number } = { elapsedMs: Math.round(performance.now() - start) };
      if (a.change) Object.assign(r, { added: textDelta(before ?? "", textNow() ?? "") }, top ? { title: document.title } : {});
      if (a.selector) r.matches = document.querySelectorAll(a.selector).length;
      return r;
    }
    if (performance.now() - start > limit) {
      const ms = a.requestedMs ?? Math.round(performance.now() - start); // what the caller asked for, not the inner budget
      const what = [a.text && `text ${JSON.stringify(a.text)}`, a.selector && `selector ${JSON.stringify(a.selector)}`, a.uid && `uid ${a.uid}`].filter(Boolean).join(", ");
      if (a.change) throw new InjectError("TIMEOUT", `wait_for change: nothing changed in ${what || "the page"} within ${ms} ms`);
      throw new InjectError("TIMEOUT", `wait_for: ${what} not present after ${ms} ms`);
    }
    await sleep(100);
  }
}

/** Run an action and report its visible effect on this frame's text: polls ≤400 ms, stops at the first change. */
async function withEffect(callId: string, target: Element | null, act: () => string | Promise<string>): Promise<string> {
  const value = (el: Element | null) => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el as HTMLElement | null)?.isContentEditable ? (el!.textContent ?? "") : "");
  const field = target ?? deepActiveElement();
  const had = value(field) !== "" && field ? describe(field) : "";
  const before = visibleText(document.body) ?? "";
  const note = await act();
  // Events are out: if this frame now unloads before answering, the background reports that as the effect.
  void browser.runtime.sendMessage({ __fw: callId, dispatched: note }).catch(() => {});
  const start = performance.now();
  let now = before;
  while ((now = visibleText(document.body) ?? "") === before && performance.now() - start < 400) await sleep(50);
  const emptied = had && value(field) === "" ? `; ${had} emptied` : "";
  if (now === before) return `${note}\nafter: no visible change within 400 ms${emptied}`;
  return `${note}\nafter: ${textDelta(before, now, 300).replace(/\n/g, " | ") || "text changed, nothing added"}${emptied}`;
}

function rect(a: { uid?: string; fullPage?: boolean; viewport?: boolean }) {
  const doc = document.documentElement;
  if (a.uid) {
    const el = elementFor(a.uid);
    scrollIntoViewIfNeeded(el);
    const r = el.getBoundingClientRect();
    if (a.viewport) return { x: r.left, y: r.top, width: r.width, height: r.height, vw: doc.clientWidth, vh: doc.clientHeight }; // bubble anchor
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: Math.ceil(r.width), height: Math.ceil(r.height) };
  }
  if (a.fullPage) return { x: 0, y: 0, width: Math.max(doc.scrollWidth, doc.clientWidth), height: Math.max(doc.scrollHeight, doc.clientHeight) };
  return { x: window.scrollX, y: window.scrollY, width: doc.clientWidth, height: doc.clientHeight };
}

run<Args>(async (a) => {
  const done = (note: string): ActionResult => {
    const r: ActionResult = { ok: true, note };
    const d = takeDialog();
    if (d) r.dialog = d;
    return r;
  };
  const effect = (target: Element | null, act: () => string | Promise<string>) => withEffect(a.__call, target, act).then(done);
  switch (a.op) {
    case "click": {
      const el = elementFor(a.uid);
      // Firefox's pop-up blocker drops an untrusted click's new tab; keep the event to see if the page cancelled it.
      const link = a.dblClick ? null : newTabLink(el);
      let ev: Event | undefined;
      const grab = (e: Event) => void (ev ??= e);
      const r = await effect(el, async () => {
        const d = describe(el); // before the click: apps re-label buttons in their handlers
        link?.addEventListener("click", grab);
        try {
          click(el, !!a.dblClick); // dispatch is synchronous: defaultPrevented is final once it returns
        } finally {
          link?.removeEventListener("click", grab);
        }
        await sleep(50); // let synchronous handlers settle so an armed dialog is reported in this call
        return `${a.dblClick ? "double-" : ""}clicked ${d}`;
      });
      if (link && ev && !ev.defaultPrevented && /^https?:$/.test(link.protocol)) r.opens = { url: link.href, target: link.getAttribute("target") ?? "<base target>" };
      return r;
    }
    case "hover": {
      const el = elementFor(a.uid);
      const d = describe(el);
      hover(el);
      return done(`hovered ${d}`);
    }
    case "fill": {
      const el = controlOf(elementFor(a.uid));
      return effect(el, () => fill(el, a.value));
    }
    case "type": {
      const el = a.uid ? controlOf(elementFor(a.uid)) : null;
      return effect(el, () => typeText(el, a.text) + (a.submit ? (press("Enter", []), " and pressed Enter") : ""));
    }
    case "press":
      return effect(null, () => press(a.key, a.modifiers ?? []));
    case "selectOption": {
      const el = controlOf(elementFor(a.uid));
      return effect(el, () => selectOption(el, a.values));
    }
    case "upload": {
      const el = controlOf(elementFor(a.uid));
      return effect(el, () => upload(el, a.files));
    }
    case "waitFor":
      return waitFor(a);
    case "pageText": {
      const els = a.uid ? [elementFor(a.uid)] : a.selector ? Array.from(document.querySelectorAll(a.selector)) : [document.body];
      if (a.selector && !a.uid && !els.length) throw new InjectError("BAD_PARAMS", `CSS selector ${JSON.stringify(a.selector)} matched nothing`);
      const full = els.map((e) => (e as HTMLElement | null)?.innerText ?? e?.textContent ?? "").join("\n\n");
      const max = a.maxLength ?? 20_000;
      return { text: full.length > max ? full.slice(0, max) : full, length: full.length, matches: els.length };
    }
    case "rect":
      return rect(a);
    default:
      throw new InjectError("BAD_PARAMS", `unknown op ${(a as { op: string }).op}`);
  }
});
