// Thought bubble: a user-origin stylesheet drawing on html::after (text) and html::before (tail). It adds no DOM
// nodes and runs no page script (docs/DESIGN.md §7.1). Pure functions, unit-tested in test/bubble.test.ts.

/** Target element's viewport rect plus the viewport size, from the `rect` op with `viewport: true`. */
export interface Anchor { x: number; y: number; width: number; height: number; vw: number; vh: number }

/** Quote s as a CSS string: escape \ and ", newlines → \a, tabs → space, drop other control characters. */
export function cssString(s: string): string {
  const t = s.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
  return `"${t.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\a ")}"`;
}

const BG = "rgba(24, 24, 28, 0.86)";
const MAX_W = 340;
const GAP = 18; // element ↔ bubble, room for the tail
const clamp = (n: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, n)));
const decl = (o: Record<string, string | number>) => Object.entries(o).map(([k, v]) => `  ${k}: ${v} !important;`).join("\n");

/** Shared by both pseudo-elements: out of flow, on top, inert, immune to the page's own styling of them. */
const BASE = {
  position: "fixed", "z-index": 2147483647, "pointer-events": "none", display: "block", visibility: "visible",
  "box-sizing": "border-box", margin: 0, float: "none", transform: "none", filter: "none", "clip-path": "none", mask: "none",
  "backdrop-filter": "blur(10px) saturate(140%)", animation: "fw-bubble-in 180ms cubic-bezier(.2,.8,.3,1.2) both",
};

/** The whole stylesheet for one bubble; anchored next to `a` when given, else bottom-centre of the viewport. */
export function bubbleCss(intent: string, a?: Anchor): string {
  const text = "🦊 " + intent;
  const w = Math.min(MAX_W, 34 + text.length * 7.2); // estimates: the stylesheet cannot measure
  const h = 21 + 19 * Math.ceil(text.length / 44);
  let place: Record<string, string | number> = { left: "50%", right: "auto", top: "auto", bottom: "24px", translate: "-50% 0", "transform-origin": "50% 100%" };
  let tail = "";
  if (a) {
    const above = a.y - GAP - h >= 8 || a.y + a.height + GAP + h > a.vh - 8;
    const left = clamp(a.x, 8, a.vw - 8 - w);
    const edge = above ? clamp(a.y - GAP, h + 8, a.vh - 8) : clamp(a.y + a.height + GAP, 8, a.vh - 8 - h); // bubble's near edge
    const tx = clamp(a.x + Math.min(24, a.width / 2) - 5, left + 14, left + w - 24);
    place = { left: `${left}px`, right: "auto", translate: "none", "transform-origin": above ? "20px 100%" : "20px 0",
      ...(above ? { top: "auto", bottom: `${Math.round(a.vh - edge)}px` } : { top: `${edge}px`, bottom: "auto" }) };
    tail = `html::before {\n${decl({ ...BASE, content: '""', left: `${tx}px`, top: `${above ? edge + 3 : edge - 12}px`, right: "auto", bottom: "auto",
      width: "9px", height: "9px", padding: 0, border: "none", "border-radius": "50%", background: BG,
      "box-shadow": `-4px ${above ? 7 : -7}px 0 -2px ${BG}, 0 2px 6px rgba(0, 0, 0, 0.25)` })}\n}\n`;
  }
  const bubble = decl({
    ...BASE, ...place, content: cssString(text), width: "max-content", height: "auto", "max-width": `min(${MAX_W}px, calc(100vw - 16px))`,
    padding: "9px 14px", border: "1px solid rgba(255, 255, 255, 0.16)", "border-radius": "18px", background: BG,
    "box-shadow": "0 8px 28px rgba(0, 0, 0, 0.28), 0 1px 3px rgba(0, 0, 0, 0.2)", color: "#f5f5f7",
    font: '500 13.5px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif', "text-align": "left", "text-transform": "none",
    "text-decoration": "none", "text-shadow": "none", "letter-spacing": "normal", "white-space": "pre-wrap", "overflow-wrap": "anywhere",
  });
  return `${tail}html::after {\n${bubble}\n}\n@keyframes fw-bubble-in { from { opacity: 0; scale: 0.92; } }
@media (prefers-reduced-motion: reduce) { html::before, html::after { animation: none !important; } }\n`;
}

/** One row of the toolbar popup's activity list (background keeps the last 50, newest first). */
export interface ActivityEntry { time: number; tabId: number; title: string; method: string; intent: string; outcome: string; closed?: boolean }
