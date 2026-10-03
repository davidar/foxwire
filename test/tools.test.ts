// take_snapshot with saveTo: the full tree goes to the file, only the header and path come back inline.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTools } from "../mcp/tools.ts";
import type { BrokerClient } from "../mcp/client.ts";
import { fwError } from "../shared/protocol.ts";

const lines = Array.from({ length: 250 }, (_, i) => `- button "b${i}" uid=${i + 1}`);
const seen: Record<string, any>[] = [];
const fake = {
  onEvent: () => {},
  request: async (m: string, p: Record<string, any>) => {
    seen.push({ m, ...p });
    if (m === "listTabs") return [{ tabId: 7, windowId: 1, index: 0, title: "T", url: "https://x.test/", active: true, windowFocused: true, status: "complete" }];
    if (m === "snapshot") return { url: "https://x.test/", title: "T", lines, frames: 1, truncated: false };
    throw new Error(`unexpected ${m}`);
  },
} as unknown as BrokerClient;

test("take_snapshot saveTo writes the full tree and returns no tree lines", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fw-tools-"));
  const file = path.join(dir, "snap.txt");
  try {
    const r = await createTools(fake).call("take_snapshot", { saveTo: file, maxLines: 10 });
    assert.equal(r.isError, undefined);
    const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    assert.match(text, /250 lines/);
    assert.ok(text.includes(file));
    assert.ok(!text.includes("uid="), "no tree lines inline");
    assert.equal(fs.readFileSync(file, "utf8"), lines.join("\n") + "\n");
    assert.equal(seen.find((s) => s.m === "snapshot")?.maxNodes, 20_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Just-in-time grants: NO_GRANT for the page's origin → requestGrant → the original call retried once.
function grantFake(grant: "yes" | "no", pattern = "https://x.test/*") {
  const calls: Record<string, any>[] = [];
  const client = {
    onEvent: () => {},
    request: async (m: string, p: Record<string, any>) => {
      calls.push({ m, ...p });
      if (m === "listTabs") return [{ tabId: 7, windowId: 1, index: 0, title: "T", url: "https://x.test/", active: true, windowFocused: true, status: "complete" }];
      if (m === "requestGrant") {
        if (grant === "yes") return { granted: true, pattern };
        throw fwError("NO_GRANT", `the user was asked and declined ${pattern}`, { pattern });
      }
      if (calls.filter((c) => c.m === m).length === 1) throw fwError("NO_GRANT", "no host grant", { origin: "https://x.test", pattern });
      return m === "screenshot" ? { dataUrl: "data:image/png;base64,AA==", width: 1, height: 1 } : { ok: true, note: "clicked" };
    },
  } as unknown as BrokerClient;
  return { client, calls };
}
const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

test("NO_GRANT asks the user, then retries the call once with a note", async () => {
  const { client, calls } = grantFake("yes");
  const r = await createTools(client).call("click_by_uid", { uid: "3", intent: "Opening the invoice" });
  assert.equal(r.isError, undefined);
  assert.match(textOf(r), /note: the user granted https:\/\/x\.test\/\* when asked/);
  assert.match(textOf(r), /clicked/);
  const ask = calls.find((c) => c.m === "requestGrant");
  assert.deepEqual(ask, { m: "requestGrant", tabId: 7, intent: "Opening the invoice", timeoutMs: 60_000 });
  assert.equal(calls.filter((c) => c.m === "click").length, 2);
});

test("declined requestGrant surfaces NO_GRANT without retrying", async () => {
  const { client, calls } = grantFake("no");
  const r = await createTools(client).call("click_by_uid", { uid: "3" });
  assert.equal(r.isError, true);
  assert.match(textOf(r), /^NO_GRANT: the user was asked and declined/m);
  assert.match(textOf(r), /hint: .*do not retry in a loop/);
  assert.equal(calls.filter((c) => c.m === "click").length, 1);
});

test("<all_urls> NO_GRANT (screenshot) does not ask", async () => {
  const { client, calls } = grantFake("yes", "<all_urls>");
  const r = await createTools(client).call("screenshot_page", {});
  assert.equal(r.isError, true);
  assert.ok(!calls.some((c) => c.m === "requestGrant"));
  assert.equal(calls.filter((c) => c.m === "screenshot").length, 1);
});

test("wait_for change prints the added text; text with change is BAD_PARAMS", async () => {
  const calls: Record<string, any>[] = [];
  const client = {
    onEvent: () => {},
    request: async (m: string, p: Record<string, any>) => {
      calls.push({ m, ...p });
      if (m === "listTabs") return [{ tabId: 7, windowId: 1, index: 0, title: "T", url: "https://x.test/", active: true, windowFocused: true, status: "complete" }];
      return { elapsedMs: 3411.6, added: "Sure, see you at 5" };
    },
  } as unknown as BrokerClient;
  const tools = createTools(client);
  const r = await tools.call("wait_for", { change: true, selector: "#log" });
  assert.match(textOf(r), /(^|\n)changed after 3412 ms:\nSure, see you at 5$/);
  assert.deepEqual({ ...calls.find((c) => c.m === "waitFor"), m: undefined }, { m: undefined, tabId: 7, text: undefined, selector: "#log", uid: undefined, change: true, timeoutMs: 10_000 });
  const bad = await tools.call("wait_for", { change: true, text: "hi" });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /BAD_PARAMS/);
  assert.equal(calls.filter((c) => c.m === "waitFor").length, 1);
});

// A fake broker that answers listTabs with three tabs and anything else from `answers`.
function scripted(answers: Record<string, any>) {
  const calls: Record<string, any>[] = [];
  const tabs = [
    { tabId: 7, windowId: 1, index: 0, title: "Inbox", url: "https://mail.test/", active: true, windowFocused: true, status: "complete" },
    { tabId: 8, windowId: 1, index: 1, title: "Chat with Sonia", url: "https://chat.test/c/1", active: false, windowFocused: true, status: "complete" },
    { tabId: 9, windowId: 1, index: 2, title: "Docs", url: "https://docs.test/CHAT-guide", active: false, windowFocused: true, status: "complete" },
  ];
  const client = {
    onEvent: () => {},
    request: async (m: string, p: Record<string, any>) => {
      calls.push({ m, ...p });
      if (m === "listTabs") return tabs;
      if (m in answers) return answers[m];
      throw new Error(`unexpected ${m}`);
    },
  } as unknown as BrokerClient;
  return { tools: createTools(client), calls };
}

test("sleep: no extension call, no intent param", async () => {
  const { tools, calls } = scripted({});
  const t0 = Date.now();
  assert.equal(textOf(await tools.call("sleep", { ms: 30 })), "slept 30 ms");
  assert.ok(Date.now() - t0 >= 25);
  assert.equal(calls.length, 0);
  assert.equal((tools.list().find((d) => d.name === "sleep")!.inputSchema.properties as Record<string, unknown>).intent, undefined);
  assert.equal((await tools.call("sleep", { ms: 0 })).isError, true);
});

test("list_pages filter keeps full-listing idx and counts matches; select_page idx agrees", async () => {
  const { tools } = scripted({});
  const out = textOf(await tools.call("list_pages", { filter: "chat" }));
  assert.equal(out.split("\n")[0], "2 of 3 tabs match");
  assert.match(out, /^\[1\] Chat with Sonia/m);
  assert.match(out, /^\[2\] Docs/m);
  assert.doesNotMatch(out, /Inbox/);
  assert.match(textOf(await tools.call("select_page", { idx: 2 })), /selected \[2\] Docs/);
  assert.doesNotMatch(textOf(await tools.call("list_pages", {})), /tabs match/);
});

test("get_page_text with a selector reports where it matched; selector+uid is BAD_PARAMS", async () => {
  const { tools, calls } = scripted({ pageText: { text: "hello there", length: 11, matches: 2, frame: "frame f1 https://chat.test", otherFrames: 1 } });
  const out = textOf(await tools.call("get_page_text", { selector: ".msg" }));
  assert.match(out, /matched 2 element\(s\) in frame f1 https:\/\/chat\.test; 1 other frame\(s\) match too\nhello there$/);
  assert.equal(calls.find((c) => c.m === "pageText")?.selector, ".msg");
  const bad = await tools.call("get_page_text", { selector: ".msg", uid: "3abc" });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /BAD_PARAMS/);
});

test("type_text submit is passed through; the after-note is printed as is", async () => {
  const note = 'typed 2 chars into <textarea "Message"> and pressed Enter\nafter: hi | Sent; <textarea "Message"> emptied';
  const { tools, calls } = scripted({ type: { ok: true, note } });
  assert.match(textOf(await tools.call("type_text", { text: "hi", uid: "4abc", submit: true })), /pressed Enter\nafter: hi \| Sent/);
  assert.equal(calls.find((c) => c.m === "type")?.submit, true);
});

test("wait_for reports selector matches, frame and title", async () => {
  const { tools } = scripted({ waitFor: { elapsedMs: 12, matches: 3, frame: "frame f1 https://chat.example.com" } });
  assert.match(textOf(await tools.call("wait_for", { selector: ".row" })), /appeared after 12 ms \(3 matches, frame f1 https:\/\/chat\.example\.com\)$/);
  const t = scripted({ waitFor: { elapsedMs: 3412, added: "", title: "New message from Sonia" } });
  assert.match(textOf(await t.tools.call("wait_for", { change: true })), /changed after 3412 ms \(title: "New message from Sonia"\):\n\(no text added\)$/);
});
