// Where the broker keeps its secret, socket and log. One place, so RELEASE.md's "undo" is exact.
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT } from "../shared/protocol.ts";

export function configDir(): string {
  return process.env.FOXWIRE_CONFIG_DIR ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "foxwire");
}
export function secretPath(): string {
  return path.join(configDir(), "secret");
}
export function logPath(): string {
  return path.join(configDir(), "broker.log");
}
export function socketPath(): string {
  if (process.env.FOXWIRE_SOCKET) return process.env.FOXWIRE_SOCKET;
  const run = process.env.XDG_RUNTIME_DIR;
  return run ? path.join(run, "foxwire.sock") : path.join(os.tmpdir(), `foxwire-${os.userInfo().uid}.sock`);
}
export function port(): number {
  const p = Number(process.env.FOXWIRE_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`bad FOXWIRE_PORT: ${process.env.FOXWIRE_PORT}`);
  return p;
}
