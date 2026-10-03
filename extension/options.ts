// foxwire options page: secret/port, evaluate toggle, per-origin host grants. Plain DOM, no framework.
import { DEFAULT_PORT } from "../shared/protocol.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const secret = $<HTMLInputElement>("secret");
const port = $<HTMLInputElement>("port");
const toggle = $<HTMLButtonElement>("toggle");
const saved = $<HTMLSpanElement>("saved");
const statusEl = $<HTMLSpanElement>("status");
const evaluate = $<HTMLInputElement>("evaluate");
const bubble = $<HTMLInputElement>("bubble");
const grants = $<HTMLUListElement>("grants");
const pattern = $<HTMLInputElement>("pattern");
const grantError = $<HTMLParagraphElement>("grantError");

interface BgStatus {
  connected: boolean;
  paired: boolean;
  lastError: string;
  since: number;
  port: number;
  hasSecret: boolean;
  evaluateEnabled: boolean;
}

async function load(): Promise<void> {
  const s = (await browser.storage.local.get(["secret", "port", "evaluateEnabled", "bubbleEnabled"])) as {
    secret?: string; port?: number; evaluateEnabled?: boolean; bubbleEnabled?: boolean;
  };
  secret.value = s.secret ?? "";
  port.value = String(s.port ?? DEFAULT_PORT);
  evaluate.checked = s.evaluateEnabled === true;
  bubble.checked = s.bubbleEnabled !== false;
}

toggle.addEventListener("click", () => {
  const show = secret.type === "password";
  secret.type = show ? "text" : "password";
  toggle.textContent = show ? "Hide" : "Show";
});

$("save").addEventListener("click", async () => {
  const value = secret.value.trim();
  const p = Number(port.value || DEFAULT_PORT);
  if (value && !/^[0-9a-f]+$/i.test(value)) return void (saved.textContent = "secret must be hex (as printed by the broker)");
  if (!Number.isInteger(p) || p < 1 || p > 65535) return void (saved.textContent = "port must be 1–65535");
  await browser.storage.local.set({ secret: value, port: p });
  saved.textContent = `saved ${new Date().toLocaleTimeString()}`;
  void poll();
});

evaluate.addEventListener("change", () => void browser.storage.local.set({ evaluateEnabled: evaluate.checked }));
bubble.addEventListener("change", () => void browser.storage.local.set({ bubbleEnabled: bubble.checked }));

function ago(ms: number): string {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

async function poll(): Promise<void> {
  try {
    const st = (await browser.runtime.sendMessage({ type: "fw.status" })) as BgStatus;
    let text: string;
    let cls: string;
    if (st.paired) [text, cls] = [`paired with broker on 127.0.0.1:${st.port}`, "ok"];
    else if (!st.hasSecret) [text, cls] = ["not connected: no secret set", "bad"];
    else if (st.connected) [text, cls] = [`connected to 127.0.0.1:${st.port}, authenticating…`, "warn"];
    else [text, cls] = [`connecting to 127.0.0.1:${st.port}${st.lastError ? ` — ${st.lastError}` : ""}`, "warn"];
    statusEl.textContent = `${text} (since ${ago(st.since)})`;
    statusEl.className = cls;
  } catch (e) {
    statusEl.textContent = `background not answering: ${(e as Error).message}`;
    statusEl.className = "bad";
  }
}

async function renderGrants(): Promise<void> {
  const origins = (await browser.permissions.getAll()).origins ?? [];
  const optional = origins.filter((o) => o !== "http://127.0.0.1/*"); // required permission, not removable
  grants.replaceChildren();
  if (!optional.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "No sites granted yet.";
    grants.append(li);
  }
  for (const o of optional) {
    const li = document.createElement("li");
    const code = document.createElement("code");
    code.textContent = o === "<all_urls>" ? "<all_urls> (all sites)" : o;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      grantError.textContent = "";
      try {
        if (!(await browser.permissions.remove({ origins: [o] }))) grantError.textContent = `could not remove ${o}`;
      } catch (e) {
        grantError.textContent = (e as Error).message;
      }
      void renderGrants();
    });
    li.append(code, btn);
    grants.append(li);
  }
}

const PATTERN_RE = /^(\*|https?|file|wss?):\/\/(\*|\*\.[^/*:]+|[^/*:]+)?\/.*$/;

function request(origin: string): void {
  grantError.textContent = "";
  // permissions.request must be called synchronously inside the click handler (user gesture).
  browser.permissions.request({ origins: [origin] }).then(
    (granted) => {
      if (!granted) grantError.textContent = `${origin} was not granted`;
      else pattern.value = "";
      void renderGrants();
    },
    (e: Error) => (grantError.textContent = e.message),
  );
}

$("grant").addEventListener("click", () => {
  const v = pattern.value.trim();
  if (!v) return void (grantError.textContent = "enter a match pattern, e.g. https://mail.google.com/*");
  if (!PATTERN_RE.test(v)) return void (grantError.textContent = `${JSON.stringify(v)} is not a match pattern (scheme://host/path, e.g. https://*.example.com/*)`);
  request(v);
});
$("grantAll").addEventListener("click", () => request("<all_urls>"));
pattern.addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("grant").click();
});

browser.permissions.onAdded.addListener(() => void renderGrants());
browser.permissions.onRemoved.addListener(() => void renderGrants());

void load();
void renderGrants();
void poll();
setInterval(() => void poll(), 2000);
