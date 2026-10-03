// Pairing secret: 32 random bytes, hex, in a 0600 file. Printed to a TTY once, on creation, never logged.
import fs from "node:fs";
import path from "node:path";
import { randomHex } from "../shared/hmac.ts";

export interface SecretInfo {
  secret: string;
  created: boolean;
  path: string;
}

export function loadOrCreateSecret(file: string): SecretInfo {
  try {
    const s = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(s)) return { secret: s, created: false, path: file };
    throw new Error(`${file} is not a 64-hex-char secret; delete it to regenerate`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const secret = randomHex(32);
  fs.writeFileSync(file, secret + "\n", { mode: 0o600, flag: "wx" });
  return { secret, created: true, path: file };
}

/** Shown exactly once, and only when a human is on the other end of stdout. */
export function announceSecret(info: SecretInfo): void {
  if (!info.created) return;
  if (process.stdout.isTTY) {
    process.stdout.write(
      [
        "",
        "foxwire: new pairing secret generated. Paste it into the extension's options page (Firefox →",
        "about:addons → foxwire → Preferences). It is stored at " + info.path + " and will not be shown again.",
        "",
        "    " + info.secret,
        "",
      ].join("\n"),
    );
  } else {
    process.stderr.write(`foxwire: pairing secret generated at ${info.path}; copy its contents into the extension options page\n`);
  }
}
