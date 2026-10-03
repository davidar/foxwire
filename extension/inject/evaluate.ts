// evaluate_script: opt-in (extension options toggle). Default runs in the content sandbox, where `document`
// is the page DOM (Xray-wrapped) and `window.wrappedJSObject` reaches page globals; pageWorld=true evals in the
// page itself (subject to the page's CSP). docs/DESIGN.md §3.
import { InjectError, run } from "./lib.ts";

interface Args {
  fn: string;
  args?: unknown[];
  pageWorld?: boolean;
}

function jsonSafe(v: unknown): unknown {
  if (v === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return String(v);
  }
}

run<Args>(async (a) => {
  const args = a.args ?? [];
  let fn: unknown;
  if (a.pageWorld) {
    const win = window.wrappedJSObject as Window & { eval(s: string): unknown };
    try {
      fn = win.eval(`(${a.fn})`);
    } catch (e) {
      throw new InjectError("INJECT_FAILED", `page-world eval refused (CSP?): ${(e as Error).message}`);
    }
    if (typeof fn !== "function") throw new InjectError("BAD_PARAMS", "function must be a function expression");
    const result = await (fn as (...x: unknown[]) => unknown)(...(cloneInto(args, win) as unknown[]));
    return { value: jsonSafe(result) };
  }
  // eslint-disable-next-line no-new-func
  fn = new Function(`return (${a.fn});`)();
  if (typeof fn !== "function") throw new InjectError("BAD_PARAMS", "function must be a function expression, e.g. `() => document.title`");
  const result = await (fn as (...x: unknown[]) => unknown)(...args);
  return { value: jsonSafe(result) };
});
