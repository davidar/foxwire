// Snapshot walker: emits an indented text tree with `uid=N` on interactable nodes. docs/DESIGN.md §6.
// Runs per frame; the background merges frames. No framework, no page-world access beyond DOM reads.
import { InjectError, collapse, run, shadowRootOf, uidFor } from "./lib.ts";

interface Args {
  selector?: string;
  includeAll?: boolean;
  maxNodes?: number;
}

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "TITLE", "BASE"]);
const INTERACTIVE_ROLES = new Set([
  "button", "link", "checkbox", "radio", "textbox", "searchbox", "combobox", "listbox", "option", "menuitem",
  "menuitemcheckbox", "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem", "gridcell", "row",
]);
const LANDMARK_ROLES = new Set([
  "heading", "list", "listitem", "table", "row", "cell", "columnheader", "rowheader", "img", "navigation", "main",
  "form", "dialog", "alertdialog", "article", "region", "banner", "contentinfo", "complementary", "search", "tabpanel",
  "tablist", "menu", "menubar", "toolbar", "group", "alert", "status", "paragraph", "separator", "figure", "iframe",
  "option", "radiogroup", "tree", "grid", "progressbar", "definition", "term", "blockquote", "code",
]);
const TAG_ROLE: Record<string, string> = {
  A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", IMG: "img", SVG: "img", NAV: "navigation",
  MAIN: "main", FORM: "form", DIALOG: "dialog", ARTICLE: "article", SECTION: "region", HEADER: "banner",
  FOOTER: "contentinfo", ASIDE: "complementary", UL: "list", OL: "list", LI: "listitem", TABLE: "table", TR: "row",
  TD: "cell", TH: "columnheader", H1: "heading", H2: "heading", H3: "heading", H4: "heading", H5: "heading",
  H6: "heading", P: "paragraph", LABEL: "label", OPTION: "option", SUMMARY: "button", DETAILS: "group",
  IFRAME: "iframe", FRAME: "iframe", HR: "separator", FIELDSET: "group", MENU: "list", DL: "list", DT: "term",
  DD: "definition", BLOCKQUOTE: "blockquote", CODE: "code", PRE: "code", FIGURE: "figure", PROGRESS: "progressbar",
  METER: "meter", OUTPUT: "status", VIDEO: "video", AUDIO: "audio", CANVAS: "img",
};
const INPUT_ROLE: Record<string, string> = {
  button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio",
  range: "slider", number: "spinbutton", search: "searchbox", file: "button", color: "button",
  date: "textbox", "datetime-local": "textbox", month: "textbox", week: "textbox", time: "textbox",
};

function roleOf(el: Element): string {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  if (el instanceof HTMLInputElement) return INPUT_ROLE[el.type] ?? "textbox";
  if (el.tagName === "A" && !el.hasAttribute("href")) return "generic";
  if (el.tagName === "SELECT" && (el as HTMLSelectElement).multiple) return "listbox";
  return TAG_ROLE[el.tagName.toUpperCase()] ?? "generic";
}

function textOfIds(el: Element, attr: string): string {
  const ids = el.getAttribute(attr);
  if (!ids) return "";
  const root = el.getRootNode() as Document | ShadowRoot;
  return ids
    .split(/\s+/)
    .map((id) => root.getElementById?.(id)?.textContent ?? "")
    .join(" ");
}

function nameOf(el: Element, role: string): string {
  const byIds = collapse(textOfIds(el, "aria-labelledby"));
  if (byIds) return byIds;
  const aria = collapse(el.getAttribute("aria-label"));
  if (aria) return aria;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const label = Array.from(el.labels ?? [])
      .map((l) => l.textContent)
      .join(" ");
    const fromLabel = collapse(label);
    if (fromLabel) return fromLabel;
    if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type) && el.value) return collapse(el.value);
    return collapse(el.getAttribute("placeholder") ?? el.getAttribute("title") ?? el.getAttribute("name"));
  }
  if (el instanceof HTMLImageElement || el.tagName === "IMG") return collapse(el.getAttribute("alt") ?? el.getAttribute("title"));
  if (el.tagName.toLowerCase() === "svg") return collapse(el.querySelector("title")?.textContent ?? el.getAttribute("title"));
  if (el.tagName === "IFRAME" || el.tagName === "FRAME") return collapse(el.getAttribute("title") ?? el.getAttribute("name"));
  if (role === "button" || role === "link" || role === "heading" || role === "tab" || role === "menuitem" || role === "option" || role === "cell" || role === "columnheader" || role === "listitem" || INTERACTIVE_ROLES.has(role)) {
    const t = collapse(el.textContent);
    if (t) return t;
  }
  return collapse(el.getAttribute("title"));
}

function ownText(el: Element): string {
  let s = "";
  for (const n of el.childNodes) if (n.nodeType === Node.TEXT_NODE) s += n.nodeValue ?? "";
  return collapse(s, 160);
}

function isInteractable(el: Element, role: string, cursor: string): boolean {
  const tag = el.tagName;
  if (tag === "A" && el.hasAttribute("href")) return true;
  if (tag === "BUTTON" || tag === "SELECT" || tag === "TEXTAREA" || tag === "SUMMARY" || tag === "LABEL" || tag === "OPTION") return true;
  if (el instanceof HTMLInputElement) return el.type !== "hidden";
  if ((el as HTMLElement).isContentEditable && el.getAttribute("contenteditable") !== null) return true;
  if (INTERACTIVE_ROLES.has(role)) return true;
  const ti = el.getAttribute("tabindex");
  if (ti !== null && Number(ti) >= 0) return true;
  if (el.hasAttribute("onclick") || el.hasAttribute("jsaction")) return true;
  if (cursor === "pointer" && (tag === "DIV" || tag === "SPAN" || tag === "LI" || tag === "TR" || tag === "TD" || tag === "IMG" || tag === "svg")) return true;
  return false;
}

function stateAttrs(el: Element, role: string): string[] {
  const a: string[] = [];
  if (role === "heading") {
    const lvl = el.getAttribute("aria-level") ?? /^H([1-6])$/.exec(el.tagName)?.[1];
    if (lvl) a.push(`level=${lvl}`);
  }
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox" || el.type === "radio") a.push(el.checked ? "checked" : "unchecked");
    else if (el.type !== "password" && el.value) a.push(`value=${JSON.stringify(collapse(el.value, 40))}`);
    if (el.type !== "text" && el.type !== "checkbox" && el.type !== "radio" && el.type !== "submit" && el.type !== "button") a.push(`type=${el.type}`);
    if (el.placeholder) a.push(`placeholder=${JSON.stringify(collapse(el.placeholder, 40))}`);
    if (el.required) a.push("required");
  } else if (el instanceof HTMLTextAreaElement) {
    if (el.value) a.push(`value=${JSON.stringify(collapse(el.value, 40))}`);
    if (el.placeholder) a.push(`placeholder=${JSON.stringify(collapse(el.placeholder, 40))}`);
  } else if (el instanceof HTMLSelectElement) {
    const sel = Array.from(el.selectedOptions).map((o) => collapse(o.textContent, 30));
    if (sel.length) a.push(`value=${JSON.stringify(sel.join(", "))}`);
  } else if (el instanceof HTMLOptionElement) {
    if (el.selected) a.push("selected");
  } else if (el instanceof HTMLAnchorElement && el.href) {
    a.push(`href=${JSON.stringify(collapse(el.getAttribute("href"), 300))}`);
  } else if (el instanceof HTMLIFrameElement) {
    a.push(`src=${JSON.stringify(collapse(el.src, 70))}`);
  }
  for (const attr of ["aria-checked", "aria-selected", "aria-expanded", "aria-pressed", "aria-current", "aria-haspopup", "aria-invalid"]) {
    const v = el.getAttribute(attr);
    if (v !== null && v !== "false") a.push(`${attr.slice(5)}${v === "true" ? "" : `=${v}`}`);
  }
  // :disabled also covers controls inside a disabled <fieldset>; readonly fields refuse fill/type.
  if (el.matches(":disabled") || el.getAttribute("aria-disabled") === "true") a.push("disabled");
  if ((el as HTMLInputElement).readOnly === true || el.getAttribute("aria-readonly") === "true") a.push("readonly");
  if (el instanceof HTMLDetailsElement) a.push(el.open ? "expanded" : "collapsed");
  // An open combobox/menu button names the popup it controls, when that popup is itself targetable.
  const ctl = el.getAttribute("aria-expanded") === "true" ? (el.getAttribute("aria-controls") ?? el.getAttribute("aria-owns"))?.trim().split(/\s+/)[0] : undefined;
  const t = ctl ? (el.getRootNode() as Document | ShadowRoot).getElementById(ctl) : null;
  if (t && isInteractable(t, roleOf(t), getComputedStyle(t).cursor)) a.push(`controls=${uidFor(t)}`);
  return a;
}

run<Args>((args) => {
  const maxNodes = Math.max(1, Math.min(args.maxNodes ?? 4000, 20000));
  const includeAll = !!args.includeAll;
  let root: Node = document.documentElement;
  // The selector scopes the top frame only; child frames are walked whole and merged under their iframe line.
  if (args.selector && window.top === window) {
    const found = document.querySelector(args.selector);
    const role = LANDMARK_ROLES.has(args.selector) || INTERACTIVE_ROLES.has(args.selector) ? `; for the role try [role=${args.selector}]` : "";
    if (!found) throw new InjectError("BAD_PARAMS", `CSS selector ${JSON.stringify(args.selector)} matched nothing${role}`);
    root = found;
  }
  const lines: string[] = [];
  let emitted = 0;
  let truncated = false;

  const emit = (depth: number, text: string) => {
    if (emitted >= maxNodes) {
      truncated = true;
      return false;
    }
    emitted++;
    lines.push(`${"  ".repeat(depth)}- ${text}`);
    return true;
  };

  const children = (el: Element): Node[] => {
    if (el.tagName === "SLOT") {
      // A <slot> outside a real shadow tree (LWC synthetic shadow) has no assigned nodes: its content is its children.
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      return assigned.length ? assigned : Array.from(el.childNodes);
    }
    const sr = shadowRootOf(el);
    return Array.from((sr ?? el).childNodes);
  };

  const walk = (node: Node, depth: number): void => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      return; // own text is folded into the parent line
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    // File inputs are the upload target even when a styled button hides them: always emit them.
    if (el instanceof HTMLInputElement && el.type === "file") return void emit(depth, line(el, "file", nameOf(el, "file"), ""));
    const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
    const cursor = cs?.cursor ?? "";
    if (!includeAll && (el.getAttribute("aria-hidden") === "true" || (el instanceof HTMLInputElement && el.type === "hidden") || cs?.display === "none")) {
      for (const f of el.querySelectorAll("input[type=file]")) walk(f, depth);
      return;
    }
    // visibility:hidden hides this element only: a descendant can set visibility:visible (modals do), so keep walking.
    if (!includeAll && cs?.visibility === "hidden") {
      for (const c of children(el)) walk(c, depth);
      return;
    }
    if (tag === "svg" || tag === "SVG") {
      const role = roleOf(el);
      const name = nameOf(el, role);
      if (isInteractable(el, role, cursor) || name) emit(depth, line(el, role, name, cursor));
      return;
    }
    const role = roleOf(el);
    const name = nameOf(el, role);
    const text = ownText(el);
    const interactable = isInteractable(el, role, cursor);
    const landmark = LANDMARK_ROLES.has(role) || INTERACTIVE_ROLES.has(role);
    let childDepth = depth;
    if (interactable || landmark || text) {
      if (!emit(depth, line(el, role, name, cursor, text))) return;
      childDepth = depth + 1;
      // Leaf-ish interactables: don't expand text-only children (keeps buttons/links to one line).
      if ((role === "button" || role === "link" || role === "option" || role === "heading" || role === "tab" || role === "menuitem") && el.querySelector("a[href],button,input,select,textarea,[role]") === null) return;
      if (el instanceof HTMLSelectElement) {
        const opts = Array.from(el.options);
        for (const o of opts.slice(0, 30)) emit(childDepth, line(o, "option", collapse(o.textContent), ""));
        if (opts.length > 30) emit(childDepth, `… ${opts.length - 30} more options`);
        return;
      }
    }
    for (const c of children(el)) walk(c, childDepth);
  };

  const LEAFY = new Set(["button", "link", "heading", "option", "tab", "menuitem", "cell", "columnheader", "listitem", "paragraph", "label", "code", "term", "definition"]);
  const line = (el: Element, role: string, name: string, cursor: string, text = ""): string => {
    const interactable = isInteractable(el, role, cursor);
    const parts: string[] = [];
    if (role === "generic") {
      parts.push(interactable ? "clickable" : "text", JSON.stringify(name || text));
    } else {
      parts.push(role);
      if (name) parts.push(JSON.stringify(name));
      if (text && text !== name && !LEAFY.has(role)) parts.push(`text=${JSON.stringify(text)}`);
      else if (text && !name && LEAFY.has(role)) parts.push(JSON.stringify(text));
    }
    const attrs = stateAttrs(el, role);
    if (attrs.length) parts.push(`[${attrs.join(" ")}]`);
    if (interactable) parts.push(`uid=${uidFor(el)}`);
    return parts.join(" ");
  };

  walk(root, 0);
  return { url: location.href, title: document.title, lines, frames: 1, truncated };
});
