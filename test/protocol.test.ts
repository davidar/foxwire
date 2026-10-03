import { test } from "node:test";
import assert from "node:assert/strict";
import { FwErrorImpl, fwError, isEvent, isFwError, isRequest, isResponse, parseFrame, parseUid, shortUrl, type Frame } from "../shared/protocol.ts";
import { textDelta } from "../extension/inject/lib.ts";

test("parseFrame: request", () => {
  const f = parseFrame('{"id":1,"method":"listTabs","params":{}}');
  assert.deepEqual(f, { id: 1, method: "listTabs", params: {} });
  assert.ok(f && isRequest(f) && !isResponse(f) && !isEvent(f));
});

test("parseFrame: response (result and error)", () => {
  const ok = parseFrame('{"id":2,"result":[1,2]}');
  assert.ok(ok && isResponse(ok) && !isRequest(ok) && !isEvent(ok));
  const bad = parseFrame('{"id":3,"error":{"code":"NO_TAB","message":"gone"}}');
  assert.ok(bad && isResponse(bad));
  assert.equal((bad as { error: { code: string } }).error.code, "NO_TAB");
});

test("parseFrame: event", () => {
  const f = parseFrame('{"event":"tab.removed","params":{"tabId":4}}');
  assert.ok(f && isEvent(f) && !isRequest(f) && !isResponse(f));
});

test("parseFrame: garbage and non-frames return null", () => {
  for (const s of ["", "not json", "{", "null", "42", '"str"', "[]", "{}", '{"id":"1","method":"x"}', '{"id":null,"result":1}', '{"event":5}'])
    assert.equal(parseFrame(s), null, s);
});

test("isRequest rejects a non-string method", () => {
  assert.equal(isRequest({ id: 1, method: 5 } as unknown as Frame), false);
});

test("FwErrorImpl.toJSON omits data when absent", () => {
  const e = fwError("TIMEOUT", "slow");
  assert.ok(e instanceof FwErrorImpl && e instanceof Error);
  assert.equal(e.name, "FwError");
  assert.deepEqual(e.toJSON(), { code: "TIMEOUT", message: "slow" });
  assert.equal(JSON.stringify(e), '{"code":"TIMEOUT","message":"slow"}');
});

test("FwErrorImpl.toJSON includes data when present", () => {
  assert.deepEqual(new FwErrorImpl("NO_GRANT", "no grant", { origin: "https://x" }).toJSON(), {
    code: "NO_GRANT",
    message: "no grant",
    data: { origin: "https://x" },
  });
});

test("isFwError", () => {
  assert.equal(isFwError({ code: "STALE_UID", message: "m" }), true);
  assert.equal(isFwError(fwError("DISABLED", "off")), true);
  assert.equal(isFwError({ code: "UNKNOWN", message: "m" }), false);
  assert.equal(isFwError({ code: "TIMEOUT" }), false);
  assert.equal(isFwError(null), false);
  assert.equal(isFwError("TIMEOUT"), false);
});

test("parseUid: top frame, frame alias, legacy tagless, malformed", () => {
  assert.deepEqual(parseUid("37kqx"), { frame: 0, uid: "37kqx" });
  assert.deepEqual(parseUid("f2_37kqx"), { frame: 2, uid: "37kqx" });
  assert.deepEqual(parseUid("f12_5abc"), { frame: 12, uid: "5abc" });
  assert.deepEqual(parseUid("12"), { frame: 0, uid: "12" }); // reaches the frame, which reports STALE_UID
  assert.deepEqual(parseUid("12kq"), { frame: 0, uid: "12kq" }); // 2-letter tag from an older build: stale in the frame
  for (const bad of ["", "kq37", "f7_", "37KQX", "37kqxz", "f_3abc", "f0_3abc", "e5"]) {
    assert.throws(() => parseUid(bad), (e: unknown) => isFwError(e) && e.code === "BAD_PARAMS" && /12kqx/.test(e.message));
  }
});

test("textDelta: appended suffix, else new lines, capped", () => {
  assert.equal(textDelta("Hi\nHow are you", "Hi\nHow are you\nFine thanks"), "Fine thanks");
  assert.equal(textDelta("a\nb\nTyping…", "a\nb\nNew reply"), "New reply");
  assert.equal(textDelta("x", "x" + "y".repeat(5000)).length, 2000);
  assert.equal(textDelta("a\nb", "b"), "");
});

test("shortUrl: origin + pathname, no query/fragment, long paths cut", () => {
  assert.equal(shortUrl("https://js.stripe.com/v3/m-outer-93afeeb17bc37e711759584dbfc50d47.html#url=https%3A%2F%2Fx&title=y"), "https://js.stripe.com/v3/m-outer-93afeeb17bc37e711759584dbfc50d47.html?…");
  assert.equal(shortUrl("https://a.test/x"), "https://a.test/x");
  const long = shortUrl("https://a.test/" + "p".repeat(100));
  assert.equal(long, "https://a.test/" + "p".repeat(58) + "…");
  assert.equal(shortUrl("not a url"), "not a url");
});
