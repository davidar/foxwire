// arm_dialog: pre-arm alert/confirm/prompt for the next dialog. This is the ONE place foxwire touches the
// page world outside evaluate_script: the overrides restore themselves on first use or after `ttlMs`,
// and the swallowed dialog is reported on the next action (lib.ts takeDialog). docs/DESIGN.md §5.
import { run } from "./lib.ts";

interface Args {
  accept: boolean;
  promptText?: string;
  ttlMs?: number;
}
type Fired = { type: "alert" | "confirm" | "prompt"; message: string; returned: unknown };
interface State {
  fired?: Fired;
  restore?: () => void;
}

run<Args>((a) => {
  const g = globalThis as unknown as { __fw_dialog?: State };
  g.__fw_dialog?.restore?.(); // re-arming replaces the previous arm
  const state: State = {};
  g.__fw_dialog = state;
  const win = window.wrappedJSObject as Window & Record<string, unknown>;
  const saved = { alert: win.alert, confirm: win.confirm, prompt: win.prompt };
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    win.alert = saved.alert;
    win.confirm = saved.confirm;
    win.prompt = saved.prompt;
    delete state.restore;
  };
  const record = (fired: Fired) => {
    state.fired = fired;
    restore();
  };
  win.alert = exportFunction((msg?: unknown) => record({ type: "alert", message: String(msg ?? ""), returned: undefined }), win);
  win.confirm = exportFunction((msg?: unknown) => {
    record({ type: "confirm", message: String(msg ?? ""), returned: a.accept });
    return a.accept;
  }, win);
  win.prompt = exportFunction((msg?: unknown, def?: unknown) => {
    const ret = a.accept ? (a.promptText ?? (def === undefined ? "" : String(def))) : null;
    record({ type: "prompt", message: String(msg ?? ""), returned: ret });
    return ret;
  }, win);
  state.restore = restore;
  setTimeout(restore, Math.min(a.ttlMs ?? 30_000, 120_000));
  return { ok: true, note: `next dialog will be ${a.accept ? "accepted" : "dismissed"}; override auto-removes after ${Math.min(a.ttlMs ?? 30_000, 120_000)} ms` };
});
