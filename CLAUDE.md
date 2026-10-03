# foxwire — contributor and agent brief

foxwire is a Firefox WebExtension, a loopback broker and a stdio MCP server that let an MCP client (Claude Code or
any other) drive the user's real, logged-in Firefox without WebDriver or Marionette.

Read `docs/DESIGN.md` in full before changing code. `docs/PRIOR-ART.md` surveys existing extensions and why none
was adopted. `docs/WHY-NOT-WEBDRIVER.md` explains why the Marionette route was rejected. `docs/RELEASE.md` covers the
dev loop, signing, install and undo.

## Hard rules (from the design; don't relax without the maintainer)

- No `content_scripts` in the manifest. Page code runs only inside a tool call via `tabs.executeScript`, and cleans up.
- Nothing on `window` or in the page world, ever, except the opt-in `evaluate_script` tool (off by default).
- Broker binds `127.0.0.1` only. Extension must pass the HMAC handshake; `Origin` must be `moz-extension://`.
- Site access via optional host permissions granted by the user; tools fail with `NO_GRANT`, never silently widen.
- Every browser call has a timeout and returns a named error code (`shared/protocol.ts`). No "unknown error".
- Size: the target was ≤ 2,500 lines of TS across extension + broker + mcp; it is currently about 3,100. Resist
  growth. No frameworks, and zero runtime deps beyond `@modelcontextprotocol/sdk` and `ws`.
- Secrets and AMO API keys never enter an agent's context: the broker prints the pairing secret once; signing keys
  come from the maintainer's environment. Don't `cat` `~/.config/foxwire/secret`, `amo.env`, or any `.env`.
- Don't install into the user's real Firefox profile, and don't sign, without the maintainer: temporary load
  (`about:debugging`) and `web-ext sign` are their clicks and commands. Build, lint, unit tests, and a
  scratch-profile `web-ext run` are fine.

## Conventions

- TypeScript, `esbuild` bundles, `web-ext lint` clean, MV2 manifest. The gecko id `foxwire@vidr.cc` is fixed by
  signing; don't change it in this repo.
- Erasable TS syntax only (`erasableSyntaxOnly`: no enums, namespaces or parameter properties), because the tests
  run under Node's type stripping without a compile step.
- Tool names and semantics mirror `@mozilla/firefox-devtools-mcp` where they overlap (`list_pages`,
  `take_snapshot`, `click_by_uid`, `fill_by_uid`, `screenshot_page`, `evaluate_script`…); see DESIGN §5.
- Small commits, one per layer or per fix (shared → broker → extension → mcp → scripts). Stage explicit paths,
  never `git add -A`. Commit messages end with the attribution line your tool provides.

## Where things are

```
shared/      wire protocol, error codes, uid parsing, HMAC helpers
broker/      loopback WebSocket for the extension + Unix socket for MCP clients; pairing secret; paths
extension/   MV2 background, thought bubble CSS, options page, toolbar popup, manifest
extension/inject/   per-call page scripts (snapshot, actions, text, …), bundled to extension/dist/inject/
mcp/         stdio MCP server, tool schemas and handlers, broker client (spawns the broker on demand)
scripts/     esbuild build, MCP install/uninstall, signing wrapper
test/        node:test unit tests; E2E.md is the manual acceptance checklist
docs/        DESIGN, PRIOR-ART, WHY-NOT-WEBDRIVER, RELEASE
```

## How to verify

```
npm run build
npm run typecheck
npm run lint
npm test
```

## Acceptance

`test/E2E.md` is the manual checklist against a real browser (DESIGN §12). The headline test: a site behind
Cloudflare bot checks loads without a challenge while the extension is connected.

Machine-specific notes live in CLAUDE.local.md (git-ignored).
