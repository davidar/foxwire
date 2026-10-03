import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexEqual, hexToBytes, hmacHex, randomHex } from "../shared/hmac.ts";

test("hexToBytes / bytesToHex round trip", () => {
  const hex = "00017f80ff10abcdef";
  const bytes = hexToBytes(hex);
  assert.deepEqual([...bytes], [0x00, 0x01, 0x7f, 0x80, 0xff, 0x10, 0xab, 0xcd, 0xef]);
  assert.equal(bytesToHex(bytes), hex);
  assert.equal(bytesToHex(hexToBytes("ABCD")), "abcd");
  assert.equal(bytesToHex(new Uint8Array()), "");
});

test("hexToBytes rejects invalid hex", () => {
  assert.throws(() => hexToBytes("abc"), /invalid hex/);
  assert.throws(() => hexToBytes("zz"), /invalid hex/);
  assert.throws(() => hexToBytes("0x12"), /invalid hex/);
});

test("hmacHex matches RFC 4231 test case 2", async () => {
  assert.equal(
    await hmacHex("4a656665", "what do ya want for nothing?"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});

test("hexEqual", () => {
  assert.equal(hexEqual("abcd", "abcd"), true);
  assert.equal(hexEqual("abcd", "abce"), false);
  assert.equal(hexEqual("abcd", "abcd00"), false);
  assert.equal(hexEqual("", ""), true);
});

test("randomHex(32) is 64 hex chars and differs between calls", () => {
  const a = randomHex(32);
  const b = randomHex(32);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.match(b, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
