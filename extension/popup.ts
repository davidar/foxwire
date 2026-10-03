// foxwire toolbar popup: Claude's pending site-grant requests, pairing status and the last 50 tab-targeting calls,
// newest first. Plain DOM, textContent only.
import type { ActivityEntry } from "./bubble.ts";

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text: string) =>
  Object.assign(document.createElement(tag), { className: cls, textContent: text });
const statusEl = document.getElementById("status")!;
const list = document.getElementById("list")!;
const asksEl = document.getElementById("asks")!;
type Ask = { id: string; pattern: string; origin: string; intent: string; title: string };

document.getElementById("options")!.addEventListener("click", () => void browser.runtime.openOptionsPage().then(() => window.close()));

let shown = "";
let shownAsks = "";

async function render(): Promise<void> {
  try {
    const st = (await browser.runtime.sendMessage({ type: "fw.status" })) as { paired: boolean; connected: boolean; hasSecret: boolean; port: number; lastError: string };
    const [text, cls] = st.paired ? [`paired · 127.0.0.1:${st.port}`, "ok"]
      : !st.hasSecret ? ["not connected: no secret set", "bad"]
      : [st.connected ? "authenticating…" : `connecting${st.lastError ? `: ${st.lastError}` : "…"}`, "warn"];
    Object.assign(statusEl, { textContent: text, className: cls });
  } catch (e) {
    Object.assign(statusEl, { textContent: `background not answering: ${(e as Error).message}`, className: "bad" });
  }
  const asks = ((await browser.runtime.sendMessage({ type: "fw.pending" }).catch(() => [])) ?? []) as Ask[];
  if (JSON.stringify(asks) !== shownAsks) {
    shownAsks = JSON.stringify(asks);
    asksEl.replaceChildren(...(asks.length ? [el("h2", "", "Claude is asking for access"), ...asks.map(askRow)] : []));
  }
  const entries = ((await browser.runtime.sendMessage({ type: "fw.activity" }).catch(() => [])) ?? []) as ActivityEntry[];
  if (JSON.stringify(entries) === shown) return;
  shown = JSON.stringify(entries);
  list.replaceChildren(...entries.map(row));
  if (!entries.length) list.append(el("li", "empty", "No activity yet."));
}

function askRow(a: Ask): HTMLDivElement {
  const div = el("div", "ask", "");
  const allow = el("button", "allow", "Allow");
  const deny = el("button", "", "Deny");
  const sendDeny = () => void browser.runtime.sendMessage({ type: "fw.deny", id: a.id }).then(render);
  // Exactly this one pattern, requested synchronously in the click (user gesture). Firefox shows its own prompt and
  // may close this popup; the background learns the answer from permissions.onAdded.
  allow.addEventListener("click", () => void browser.permissions.request({ origins: [a.pattern] }).then((ok) => (ok ? render() : sendDeny()), () => {}));
  deny.addEventListener("click", sendDeny);
  div.append(el("strong", "", a.origin), el("code", "", a.pattern));
  if (a.intent) div.append(el("div", "", a.intent));
  if (a.title) div.append(el("div", "muted", a.title));
  const btns = el("div", "btns", "");
  btns.append(allow, deny);
  div.append(btns);
  return div;
}

function row(a: ActivityEntry): HTMLLIElement {
  const li = el("li", "", "");
  const main = el("div", "main", a.intent);
  if (!a.intent) main.append(el("span", "muted", a.method));
  if (a.outcome !== "ok") main.append(el("span", "err", a.outcome));
  li.append(el("time", "", new Date(a.time).toTimeString().slice(0, 8)), main, el("div", "tab", a.title || `tab ${a.tabId}`));
  li.title = `${a.method} · tab ${a.tabId}`;
  li.addEventListener("click", async () => {
    try {
      const t = await browser.tabs.update(a.tabId, { active: true });
      if (t?.windowId !== undefined) await browser.windows.update(t.windowId, { focused: true });
      window.close();
    } catch {
      li.classList.add("muted"); // tab is gone
    }
  });
  return li;
}

void render();
setInterval(() => void render(), 1500);
