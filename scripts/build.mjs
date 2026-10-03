// foxwire build: esbuild bundles for the extension, its injected scripts, the broker and the mcp server.
// Usage: node scripts/build.mjs [--watch] [--only extension,inject,broker,mcp]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p) => path.relative(root, p);

const browserOpts = { bundle: true, format: "iife", target: "firefox140", platform: "browser", sourcemap: false, minify: false };
const nodeOpts = { bundle: true, format: "esm", target: "node22", platform: "node", packages: "external", sourcemap: false, minify: false };

/** target name → list of { entry, outfile, options } (paths relative to repo root) */
const TARGETS = {
  extension: [
    { entry: "extension/background.ts", outfile: "extension/dist/background.js", opts: browserOpts },
    { entry: "extension/options.ts", outfile: "extension/dist/options.js", opts: browserOpts },
    { entry: "extension/popup.ts", outfile: "extension/dist/popup.js", opts: browserOpts },
  ],
  inject: ["snapshot", "actions", "dialog", "evaluate"].map((n) => ({
    entry: `extension/inject/${n}.ts`,
    outfile: `extension/dist/inject/${n}.js`,
    opts: browserOpts,
  })),
  broker: [{ entry: "broker/broker.ts", outfile: "broker/dist/broker.js", opts: nodeOpts }],
  mcp: [{ entry: "mcp/server.ts", outfile: "mcp/dist/server.js", opts: nodeOpts }],
};

function parseArgs(argv) {
  const out = { watch: false, only: Object.keys(TARGETS) };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--watch") out.watch = true;
    else if (a === "--only" || a.startsWith("--only=")) {
      const v = a.includes("=") ? a.slice(7) : argv[++i];
      if (!v) fail("--only needs a comma-separated list");
      out.only = v.split(",").map((s) => s.trim()).filter(Boolean);
      for (const t of out.only) if (!(t in TARGETS)) fail(`unknown target "${t}" (known: ${Object.keys(TARGETS).join(", ")})`);
    } else fail(`unknown argument "${a}"`);
  }
  return out;
}

function fail(msg) {
  console.error(`build: ${msg}`);
  process.exit(1);
}

function fmtSize(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`;
}

/** esbuild plugin: print one line per output after every (re)build. */
const report = {
  name: "foxwire-report",
  setup(build) {
    build.onEnd((res) => {
      if (res.errors.length) return;
      const out = build.initialOptions.outfile;
      console.log(`  ${rel(out).padEnd(36)} ${fmtSize(fs.statSync(out).size)}`);
    });
  },
};

async function main() {
  const { watch, only } = parseArgs(process.argv.slice(2));
  const jobs = only.flatMap((t) => TARGETS[t]);
  const missing = jobs.filter((j) => !fs.existsSync(path.join(root, j.entry)));
  if (missing.length) fail(`missing entry file(s): ${missing.map((j) => j.entry).join(", ")}`);

  const configs = jobs.map((j) => ({
    ...j.opts,
    entryPoints: [path.join(root, j.entry)],
    outfile: path.join(root, j.outfile),
    logLevel: "warning",
    plugins: [report],
  }));

  console.log(`build: ${only.join(", ")}${watch ? " (watch)" : ""}`);
  if (watch) {
    const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log("build: watching for changes (Ctrl-C to stop)");
    const stop = async () => {
      await Promise.all(ctxs.map((c) => c.dispose()));
      process.exit(0);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  const failed = [];
  for (const c of configs) {
    try {
      await esbuild.build(c);
    } catch {
      failed.push(rel(c.entryPoints[0]));
    }
  }
  if (failed.length) fail(`failed: ${failed.join(", ")} (see errors above)`);
}

await main();
