// HMAC-SHA256 pairing primitives. WebCrypto only, so the same file runs in Node and in the extension.

const subtle = () => globalThis.crypto.subtle;

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function randomHex(nBytes: number): string {
  const b = new Uint8Array(nBytes);
  globalThis.crypto.getRandomValues(b);
  return bytesToHex(b);
}

/** HMAC-SHA256(secretHex, messageUtf8) → hex. */
export async function hmacHex(secretHex: string, message: string): Promise<string> {
  const key = await subtle().importKey(
    "raw",
    hexToBytes(secretHex) as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle().sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/** Constant-time comparison of two hex strings. */
export function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
