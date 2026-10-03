// Thought bubble: CSS string escaping, generated stylesheet shape, and the mcp `intent` pass-through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bubbleCss, cssString } from "../extension/bubble.ts";
import { createTools } from "../mcp/tools.ts";
import type { BrokerClient } from "../mcp/client.ts";

test("cssString escapes quotes, backslashes and newlines", () => {
  assert.equal(cssString('say "hi"'), '"say \\"hi\\""');
  assert.equal(cssString("C:\\path\\"), '"C:\\\\path\\\\"');
  assert.equal(cssString("a\nb\r\nc\rd"), '"a\\a b\\a c\\a d"');
  assert.equal(cssString("\\a"), '"\\\\a"'); // a literal backslash-a stays literal
});

test("cssString drops control chars, keeps markup-like text, non-ASCII and emoji", () => {
  assert.equal(cssString("x\u0000\u0007\u001b\u007f\u0085y\tz"), '"xy z"');
  assert.equal(cssString("</style><script>alert(1)</script>"), '"</style><script>alert(1)</script>"');
  assert.equal(cssString("Ünïcödé 日本語 🦊👍🏽"), '"Ünïcödé 日本語 🦊👍🏽"');
  assert.equal(cssString("} html { display: none"), '"} html { display: none"'); // inert inside the string
});

test("bubbleCss: one string token, no raw newlines in it, everything !important", () => {
  const css = bubbleCss('Line one\nhe said "x" } @import url(evil)');
  const content = /content: (".*") !important;/.exec(css)?.[1];
  assert.equal(content, '"🦊 Line one\\a he said \\"x\\" } @import url(evil)"');
  for (const l of css.split("\n").filter((l) => /^\s+[a-z-]+: /.test(l))) assert.match(l, /!important;$/, l);
  assert.match(css, /pointer-events: none !important/);
  assert.match(css, /z-index: 2147483647 !important/);
  assert.match(css, /prefers-reduced-motion/);
});

test("bubbleCss: default bottom-centre without a tail; anchored above/below with one", () => {
  const def = bubbleCss("Reading the page");
  assert.doesNotMatch(def, /^html::before \{/m);
  assert.match(def, /bottom: 24px !important/);
  const above = bubbleCss("Clicking Save", { x: 100, y: 400, width: 80, height: 30, vw: 1200, vh: 800 });
  assert.match(above, /^html::before \{/m);
  assert.match(above, /bottom: 418px !important/); // 800 - (400 - 18)
  const below = bubbleCss("Clicking the menu", { x: 1190, y: 10, width: 40, height: 20, vw: 1200, vh: 800 });
  assert.match(below, /top: 48px !important/); // 10 + 20 + 18
  const left = Number(/left: (\d+)px/.exec(below.split("html::after")[1]!)?.[1]);
  assert.ok(left + 100 < 1200, `clamped into the viewport (left ${left})`);
});

test("mcp: intent is offered on tab tools, passed through capped, and absent elsewhere", async () => {
  const seen: Record<string, any>[] = [];
  const fake = {
    onEvent: () => {},
    request: async (m: string, p: Record<string, any>) => {
      seen.push({ m, ...p });
      if (m === "listTabs") return [{ tabId: 7, windowId: 1, index: 0, title: "T", url: "https://x.test/", active: true, windowFocused: true, status: "complete" }];
      return { ok: true };
    },
  } as unknown as BrokerClient;
  const tools = createTools(fake);
  const schema = (n: string) => tools.list().find((t) => t.name === n)!.inputSchema.properties;
  assert.ok(schema("click_by_uid").intent && schema("navigate_page").intent && schema("take_snapshot").intent);
  assert.equal(schema("list_pages").intent, undefined);
  const r = await tools.call("click_by_uid", { uid: "3", intent: "x".repeat(300) });
  assert.equal(r.isError, undefined);
  const click = seen.find((s) => s.m === "click")!;
  assert.equal(click.intent.length, 200);
  assert.ok(click.intent.endsWith("…"));
  assert.equal(seen.find((s) => s.m === "listTabs")!.intent, undefined);
  await tools.call("press_key", { key: "Enter" });
  assert.equal(seen.findLast((s) => s.m === "press")!.intent, undefined);
});
