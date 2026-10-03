import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadOrCreateSecret } from "../broker/pairing.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "foxwire-pairing-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("creates a 0600 64-hex secret, then reuses it", () => {
  const file = path.join(tmp, "cfg", "secret");
  const first = loadOrCreateSecret(file);
  assert.equal(first.created, true);
  assert.equal(first.path, file);
  assert.match(first.secret, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8").trim(), first.secret);

  const second = loadOrCreateSecret(file);
  assert.equal(second.created, false);
  assert.equal(second.secret, first.secret);
});

test("malformed secret file throws with a regenerate hint", () => {
  const file = path.join(tmp, "bad-secret");
  fs.writeFileSync(file, "not-a-secret\n", { mode: 0o600 });
  assert.throws(() => loadOrCreateSecret(file), /delete it to regenerate/);
  assert.equal(fs.readFileSync(file, "utf8"), "not-a-secret\n");
});
