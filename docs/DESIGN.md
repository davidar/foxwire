# foxwire — design

Status: the design document for foxwire, implemented as of 0.1.0; where the implementation diverged, the code and
`../README.md` win. Read `../CLAUDE.md` first, then this file, then `PRIOR-ART.md` (the survey of existing
extensions) and `WHY-NOT-WEBDRIVER.md` (why Marionette was rejected).

## 1. Goal

Let Claude Code (or any MCP client) drive the user's **real, daily, logged-in Firefox** through MCP tools, with:

- **no WebDriver** — no `--marionette`, no `--remote-debugging-port`, so `navigator.webdriver` stays `false`, no
  URL-bar robot, no "recommended automation prefs" silently applied to their profile (see `WHY-NOT-WEBDRIVER.md`);
- **always on** — a signed WebExtension that is simply installed; no relaunch, no toggle, no temporary add-on;
- **nothing a site can see** — no persistent content script, no page-world globals, no DOM markers; code touches
  a page only for the duration of a tool call and cleans up;
- **a codebase one person can read in a sitting** — target 1,500–2,500 lines across extension + server, zero
  runtime dependencies beyond `@modelcontextprotocol/sdk` and `ws`;
- **the same tool shapes** as `@mozilla/firefox-devtools-mcp` / Playwright MCP (snapshot with uids, click/fill by
  uid, screenshot, evaluate), so existing habits and reference notes carry over.

Non-goals: Chrome support, multi-machine relay, headless mode, DevTools-grade debugging (network/console capture
is a maybe-later), OS-level trusted input (no nut-js sidecar), PDF export.

## 2. Architecture

```
Claude Code session A ──stdio──▶ foxwire-mcp (thin) ──┐
Claude Code session B ──stdio──▶ foxwire-mcp (thin) ──┼─ unix socket ──▶ foxwire-broker ◀── ws://127.0.0.1:PORT ── Firefox extension
Claude Code session C ──stdio──▶ foxwire-mcp (thin) ──┘      (long-lived, one per user)                 (background script)
```

Three parts, two processes on the host plus the extension:

1. **Extension** (`extension/`): MV2 background script that dials **out** to `ws://127.0.0.1:PORT`, reconnects
   with backoff, executes commands with `browser.tabs.*`, `browser.tabs.executeScript`, `browser.tabs.captureTab`,
   and reports results. Options page: secret, port, per-site grants. No `content_scripts` in the manifest, ever.
2. **Broker** (`broker/`): long-lived host process owning the loopback WebSocket the extension connects to.
   Accepts MCP clients over a Unix socket (`$XDG_RUNTIME_DIR/foxwire.sock`), multiplexes their requests to the single
   extension connection, routes replies by request id. Started on demand by the first MCP process (spawn-detached
   if the socket is absent) or by a `systemd --user` unit — decide at build time; on-demand is fewer moving parts.
3. **MCP server** (`mcp/`): stdio MCP server (one per Claude Code session). Translates tool calls into broker
   requests. Holds **no** browser state except the "selected tab" for that session.

Why a broker: each Claude Code session spawns its own stdio MCP process, and the extension can hold one socket.
Without a broker the second session can't bind the port (FoxPilot solves this with an in-process "broker" that the
first server becomes — fine, but the detached process is simpler to reason about and survives the session that
started it).

The Firefox Flatpak has `shared=network`, so loopback is shared with the host: **no native messaging, no
`xdg-native-messaging-proxy`, no Flatpak override.** Verified 3 Oct 2026 on Firefox 157 (`flatpak info --show-permissions`).

## 3. Pairing and trust

- **Loopback only.** Broker binds `127.0.0.1` (not `0.0.0.0`, not `localhost` which may resolve to `::1`).
- **Shared secret, never sent in clear.** The broker generates a 32-byte secret on first run into
  `~/.config/foxwire/secret` (mode 0600) and prints it once; the user pastes it into the extension options page
  (stored in `browser.storage.local`). Handshake: broker sends a random nonce; extension replies
  `HMAC-SHA256(secret, nonce)`; mismatch → close. Only connections whose `Origin` header starts with
  `moz-extension://` are accepted at all (defence in depth; the HMAC is the real gate). This closes the two holes
  found in prior art: Blueprint's "first client wins, any web page can connect" and FoxPilot's default
  "any extension origin" pairing (`PRIOR-ART.md` §3, §1).
- **Site access is per-origin and opt-in.** Manifest `permissions`: `tabs`, `storage`, `webNavigation`,
  `http://127.0.0.1/*` (nothing else). `optional_permissions`: `<all_urls>`. Grants are made by the user in the
  options page per origin pattern (`permissions.request` needs a user gesture) — or, if they prefer, a one-time
  `<all_urls>` grant that Firefox then exposes per-site in the extension's panel. The `tabs` permission alone gives
  titles/URLs of all tabs (needed for `list_pages`); everything that touches page content needs a host grant and
  fails with a clear "no grant for <origin>" error otherwise.
- **Just-in-time asking.** When a tool hits `NO_GRANT` for a page's own origin, the mcp calls the extension's
  `requestGrant` (tabId or url, Claude's intent). The background cannot prompt by itself (`permissions.request`
  needs a user gesture in an extension page), so it lists the request in the toolbar popup, sets the badge to an
  orange `?` with the tooltip "Claude wants access to <origin>", and tries `browserAction.openPopup()` (usually
  refused without a gesture; the badge is the fallback). The popup shows the origin, the exact pattern
  (`https://host/*`, or `file:///*`), the intent and the tab title, with **Allow** and **Deny**. Allow calls
  `permissions.request` for exactly that one pattern in the click handler, so the grant is still the user's click on
  Firefox's own per-origin prompt; the background learns the outcome from `permissions.onAdded`, not from the popup
  (which Firefox may close). Nothing widens beyond that pattern; all-sites stays an options-page action and is
  never asked for (screenshots' `<all_urls>` `NO_GRANT` does not trigger a request). Deny is remembered in memory
  for 10 minutes: further requests for that pattern fail at once. The call waits up to ~59 s; an unanswered
  request stays in the popup for 2 more minutes so a late Allow still serves the next call. Concurrent requests for
  one pattern share one popup entry.
- **No page-world globals that outlive a call.** Injected scripts run in the extension's content-script sandbox
  (isolated world, invisible to page JS) and return plain JSON. `evaluate_script` is the one deliberate exception
  (it runs in the page world via `window.wrappedJSObject` / `window.eval`); it is opt-in via an options toggle and
  off by default, and the doc for the tool says so.
- **Secret and keys never enter a model's context.** The broker prints the secret once at generation; the MCP
  client only ever sees "paired: yes/no". The AMO API keys for signing live in the maintainer's shell env / a `.env`
  that is git-ignored; agents never read them.

## 4. Wire protocol (extension ↔ broker ↔ mcp)

JSON text frames. One request → one response, correlated by `id`. Events are unsolicited frames without `id`.

```
request   {"id": 17, "method": "snapshot", "params": {"tabId": 42, "maxNodes": 4000}}
response  {"id": 17, "result": {...}}  |  {"id": 17, "error": {"code": "NO_GRANT", "message": "…", "data": {...}}}
event     {"event": "tab.updated", "params": {"tabId": 42, "status": "complete", "url": "…"}}
```

Error codes (string enum, keep small): `NO_GRANT`, `NO_TAB`, `STALE_UID`, `TIMEOUT`, `INJECT_FAILED`,
`NOT_PAIRED`, `DISABLED`. The MCP layer maps them to readable tool errors; never a bare "unknown error" (the
Mozilla server's failure mode during the WebDriver trial — see `WHY-NOT-WEBDRIVER.md` "First live test").

The mcp ↔ broker leg reuses the same frames over the Unix socket, prefixed with the client's session id so the
broker can route replies and scope "selected tab" per client. Broker adds `broker.*` methods: `status`
(paired? extension version? firefox version?), `clients`.

## 5. Tool surface (MCP)

Names follow `@mozilla/firefox-devtools-mcp` where the semantics match, so notes written against that server
still apply. Each tool: one sentence of doc, strict input schema, small output.

| Tool | Params | Returns | Notes |
|---|---|---|---|
| `list_pages` | `filter?` | `[{idx, tabId, title, url, active, selected}]` | `filter`: case-insensitive title/url substring, prints `N of M tabs match`, idx stays the full-listing index. `tabs` permission only; no page access. URLs of ungranted http(s) tabs are shown without query string or fragment (`…?…`) so tokens stay out of context |
| `select_page` | `idx \| tabId \| url \| title` | selected tab | per-session selection, broker-scoped |
| `new_page` | `url`, `wait?` | tab | `browser.tabs.create`; `wait` = `none/interactive/complete` via `webNavigation` |
| `navigate_page` | `url`, `wait?` | — | on the selected tab |
| `navigate_history` | `delta` (−1/+1) | — | |
| `close_page` | `idx?` | — | |
| `take_snapshot` | `selector?`, `maxLines?`, `includeAll?` | text tree with `uid=` on interactable nodes | §6 |
| `get_page_text` | `maxLength?`, `selector? \| uid?` | `innerText` | no target: top-frame body. `uid`: that subtree, in its frame. `selector`: every injectable frame; text of all matches in the lowest-frameId frame that matches, headed `matched N element(s) in <top frame \| frame fK origin>` (+ how many other frames match); no match anywhere → `BAD_PARAMS` |
| `click_by_uid` | `uid`, `dblClick?` | — | scrollIntoView, then `el.click()` + synthetic mouse events; `isTrusted=false` (same as every extension driver; Turnstile's checkbox needs the user's own click) |
| `hover_by_uid` | `uid` | — | pointer events only |
| `fill_by_uid` | `uid`, `value` | — | native setter + `input`/`change` events so React/Vue/Infragistics see it (lesson from a legacy ASP.NET form using Infragistics editors: some editors need real keystrokes → fall back to `type_text`) |
| `type_text` | `text`, `uid?`, `submit?` | — | focuses uid if given, dispatches `keydown/keypress/input/keyup` per char; `submit` presses Enter in the same inject (`… and pressed Enter`) |
| `press_key` | `key`, `modifiers?` | — | `Enter`, `Tab`, `Escape`, `ArrowDown`… |
| `select_option` | `uid`, `values[]` | — | `<select>` |
| `upload_file_by_uid` | `uid`, `paths[]` | — | **host-side read**: mcp reads the file, ships bytes to the extension, builds a `File` and sets `input.files` via `DataTransfer`. Size cap 15 MB. |
| `screenshot_page` | `fullPage?` | PNG (base64 or saved path) | `tabs.captureTab`; fullPage by scroll-stitch or `rect` option |
| `screenshot_by_uid` | `uid` | PNG | `captureTab` with `rect` |
| `evaluate_script` | `function`, `args?` | JSON | page world; off unless enabled in options |
| `wait_for` | `text? \| selector? \| uid?`, `change?`, `timeoutMs?` | `added` text with `change` | polls inside one injection; with a selector the output names the match count and frame (`3 matches, frame f1 https://…`); in change mode the top frame's `document.title` changing also resolves, and the title is printed; `change: true` records the target's visible text (selector, uid, else body) and resolves when it differs, returning the appended suffix or else the new lines (≤2,000 chars); a selector absent at start counts as changed when it appears; `TIMEOUT` = nothing changed, call again; `text`+`change` → `BAD_PARAMS` |
| `sleep` | `ms` (1–60,000) | `slept N ms` | mcp only, no extension call, no `intent`; prefer `wait_for` |
| `handle_dialog` | `accept`, `promptText?` | — | pre-arm: injected `alert/confirm/prompt` override **only** for the next call, then restored — never left installed |
| `status` | — | `{paired, extensionVersion, firefoxVersion, grants[], evaluateEnabled, bubbleEnabled, asking[]}` | the health check (replaces the Mozilla server's `get_firefox_info`, which crashed in attach mode) |

**Action effects.** `click_by_uid`, `fill_by_uid`, `type_text`, `press_key`, `select_option` and
`upload_file_by_uid` read the frame's visible text (`document.body`, whitespace collapsed per line) before acting,
then poll it for up to 400 ms after, stopping at the first difference, and append one line to the note:
`after: <added text>` (the `wait_for change` diff, ≤300 chars, newlines as ` | `, plus `; <field> emptied` when the
target's or focused field's value went to empty), `after: no visible change within 400 ms` (not a failure: slow
effects are normal, do not retry), or `after: the page navigated or the frame was replaced`. For the last one the
inject messages the background as soon as the events are dispatched; if the frame then gives no answer within 2 s
it has unloaded, and the call succeeds with that note instead of failing with `TIMEOUT`. A click, press or
`type_text` submit that opens a tab (`tabs.onCreated` with `openerTabId` = the acted tab, or with no opener in the
same window, from dispatch until ≤600 ms after a quiet result) adds `after: opened tab <tabId> (<url or loading>)`,
replacing the "no visible change" wording. `wait_for` timeouts report the requested `timeoutMs`, not the inner budget.
Synthetic clicks cannot open pop-ups (Firefox's blocker drops them), so when `click_by_uid` hits a link whose
effective target (`target`, else `<base target>`) is a new browsing context, the page did not cancel the click, and
no tab appeared, foxwire opens the link's http(s) `href` itself next to its opener, noted `[link target=…]`. A
`window.open` from a click handler stays blocked unless the user allows pop-ups for the site. `fill_by_uid`,
`type_text`, `select_option` and `upload_file_by_uid` given a `<label>` (or something in one) act on its control; a
refused field says `is readonly` / `is disabled`.

Every tool that targets a tab (all except `list_pages`, `select_page`, `close_page`, `status`, `sleep`) also takes an
optional `intent`: a brief first-person note of what Claude is doing and why ("Opening the March invoice to check
the total"). The mcp caps it at 200 chars (truncates with `…`) and passes it to the extension as a request param;
the extension shows it in the thought bubble (§7.1) and the toolbar popup's activity list. It never changes what
the call does.

`NO_GRANT` on a page's own origin is not returned straight away: the mcp asks the user (§3, just-in-time asking),
and if they allow the pattern it retries the original call once and prefixes the output with
`note: the user granted <pattern> when asked`. If they decline, declined in the last 10 minutes, or does not answer
within ~60 s, the tool returns `NO_GRANT` with a hint not to retry in a loop. There is no separate grant tool.

Maybe-later (not v1): `console_messages`, `network_requests` (needs `webRequest`, widens permissions),
`list_downloads`, `set_viewport_size`, cookies.

## 6. Snapshot and uids

- One injected script walks the DOM (shadow roots included, same-origin iframes via `allFrames: true` and merged
  by frameId), emits an indented text tree like Playwright's accessibility snapshot: role, name, value, state,
  and `uid=…` for anything interactable (links, buttons, inputs, selects, textareas, contenteditable, elements with
  click handlers/`role=button`/`tabindex`). Non-interactable text is included (truncated) so the tree reads.
- uid → element map lives **in the content sandbox** (`WeakRef` list on the sandbox global, not on `window`), keyed
  per `(tabId, frameId)`; uids are stable until navigation, then `STALE_UID`. Re-snapshot invalidates nothing: a
  uid survives across snapshots while its element exists (same contract as the Mozilla server).
- uid format: `<n><tag>` in the top frame (`37kqx`), `f<k>_<n><tag>` in a subframe (`f2_37kqx`; the background
  prefixes subframe uids when merging). `tag` is three random letters picked when a frame's registry is created, i.e.
  per document and per extension load, so a uid from before a reload or navigation fails with `STALE_UID` instead of
  resolving to whatever element now holds that number. Parsed by `parseUid` in `shared/protocol.ts`.
- `k` is a short per-tab frame alias (1, 2, 3 … in first-seen order) kept by the background (alias ↔ frameId); it
  is cleared when the tab closes or its top frame commits a navigation, and lost on extension reload. An alias that
  maps to nothing → `STALE_UID`; a frame whose document was replaced keeps its alias and the tag check catches the
  stale uid. The merged snapshot marks each iframe with `[frame=fK origin]`; a frame skipped for lack of a grant
  names its origin and the exact pattern to grant.
- An expanded element whose `aria-controls`/`aria-owns` points at a targetable element gets `controls=<uid>`.
- Form controls show `disabled` (`:disabled`, so fieldset-inherited too, or `aria-disabled=true`) and `readonly`
  (`readOnly` or `aria-readonly=true`): fill/type will refuse those. Ungranted child frames are listed by origin +
  pathname only (`shortUrl`), never their query or fragment.
- A row/listitem name is truncated at about 160 chars; read its child `text` lines for the full content. Snapshot
  line count is not a change signal (use `wait_for` with `change`).
- `maxLines` default 100, `selector` scopes the walk, `saveTo` writes the full tree to a file (mcp side).
- Keep the walker in one file (`extension/inject/snapshot.ts`), no framework, <500 lines. Test against: a webmail
  inbox, a legacy ASP.NET form using Infragistics editors (and a select that posts back), a chat app behind
  Cloudflare, a shop checkout, a `<select>`-heavy government form, and a Shadow-DOM-heavy page.

## 7. Injection model

- `browser.tabs.executeScript(tabId, {code|file, frameId?, runAt: "document_idle"})` per call. Scripts are
  prebuilt bundles under `extension/dist/inject/*.js`, each an IIFE that reads its arguments from a global the
  extension sets just before (`globalThis.__fw_args`) **in the sandbox**, runs, returns JSON via the executeScript
  result, and deletes anything it created. Sandbox globals are not visible to page scripts, but keep them to the
  minimum anyway (`__fw_uids`, `__fw_args`).
- MV2 because Firefox's MV3 still runs background as an event page with quirks for long-lived sockets; MV2
  persistent background keeps the WebSocket simple. Revisit when Firefox forces MV3 (not announced as of Oct 2026).
- Timeouts: every injection has a hard timeout (default 10 s, `wait_for` up to 60 s) and returns `TIMEOUT`, never
  hangs the MCP call. (Second Mozilla-server lesson: a 60 s hang then "unknown error".)

### 7.1 Thought bubble and toolbar popup

- When a request carries `intent` and the tab's origin is granted, the background draws a bubble with
  `tabs.insertCSS(tabId, {code, cssOrigin: "user", frameId: 0})`: `html::after` holds the text (`content: "🦊 …"`),
  `html::before` a two-circle thought tail. Every declaration is `!important` in the user origin, so the page's own
  styling of those pseudo-elements cannot move or hide it; `position: fixed`, max `z-index`, `pointer-events: none`,
  so it cannot affect layout or catch events. No DOM node, no page script. The CSS is generated by
  `extension/bubble.ts` (pure, unit-tested escaping).
- Placement: with a top-frame `uid`, the `rect` op (`viewport: true`) gives the element's viewport rect and the
  bubble sits above it (or below if there is no room), clamped to the viewport, tail toward the element. Otherwise
  (subframe uid, no uid, rect lookup failed or slower than 300 ms) bottom-centre. Bubble work is bounded to ~400 ms
  and every bubble error is swallowed: it can never fail a call.
- Lifetime: one per tab; a new intent replaces the old (`removeCSS` with the identical details, then `insertCSS`).
  It stays ~4 s after the call ends. Navigations (`new_page`, `navigate_page`, `navigate_history`) show it after the
  load wait, on the new document. `screenshot_*` removes it before `captureTab` and re-shows it after.
- Switch: `bubbleEnabled` in `storage.local` (default on; options page → Tools). Off means no `insertCSS` at all.
- Toolbar button: the background keeps the last 50 tab-targeting calls in memory (time, tab, title, method, intent,
  `ok` or error code); `popup.html` lists them newest first (click → focus that tab) with the pairing status. While a
  call with an intent runs, the button's per-tab badge shows `…`; its tooltip is the latest intent.

## 8. Repo layout

```
foxwire/
  CLAUDE.md               contributor and agent brief (rules, commands, pointers)
  docs/                   DESIGN.md (this), PRIOR-ART.md, WHY-NOT-WEBDRIVER.md, RELEASE.md
  extension/              manifest.json, background.ts, bubble.ts, options.{html,ts}, popup.{html,ts}, inject/{snapshot,actions,dialog,evaluate,lib}.ts
  broker/                 broker.ts (ws server + unix socket mux), pairing.ts, paths.ts
  mcp/                    server.ts (stdio MCP), tools.ts (schemas + handlers), client.ts (unix socket)
  shared/                 protocol.ts (frame types, error codes), hmac.ts
  scripts/                build (esbuild), sign (web-ext), install-mcp (claude mcp add …)
  test/                   node:test unit tests (protocol, hmac, pairing, broker, tools, bubble); E2E.md manual checklist
```

TypeScript throughout, `esbuild` bundles (no webpack), `web-ext` for lint/sign. One `package.json` at the root, no
workspaces — keep it boring.

## 9. Install, sign, release (details in `RELEASE.md`)

- **Dev loop:** `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on…" → `extension/manifest.json`
  (dropped on Firefox restart; fine for dev). Do NOT `web-ext run` against the real profile (it launches a fresh
  profile by default — useful for tests, not for the daily browser).
- **Permanent install = signed xpi.** Release Firefox refuses unsigned add-ons; `xpinstall.signatures.required`
  is ignored on release (only Nightly / Developer Edition / ESR honour it) — Extension Workshop, signing overview.
  Self-distributed signing: `web-ext sign --channel=unlisted --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET`
  → automated review → signed `.xpi` (Mozilla: "can take up to 24 hours… or longer if selected for manual review";
  in practice minutes). Needs an AMO developer account + API key pair (the maintainer's; keys never in the repo or in a
  model's context). Manifest needs a fixed `browser_specific_settings.gecko.id` (`foxwire@vidr.cc`, tied to the
  author's AMO account; a fork signing its own build needs its own id) and, since
  3 Nov 2025, `data_collection_permissions: { required: ["none"] }`.
- **Every signed build is a version bump.** Unlisted add-ons never auto-update (no `update_url`), so what the user
  installs is what they reviewed. Install the signed xpi by opening it in Firefox.
- **MCP registration (user scope, every project):**
  `claude mcp add -s user foxwire -- node /path/to/foxwire/mcp/dist/server.js` (`scripts/install-mcp.sh`).
  The broker is spawned by the first mcp process if `$XDG_RUNTIME_DIR/foxwire.sock` is absent.
- **Undo:** remove the add-on in `about:addons`; `claude mcp remove -s user foxwire`; delete `~/.config/foxwire`.

## 10. Detectability review (what a site can observe)

| Signal | foxwire | Marionette route |
|---|---|---|
| `navigator.webdriver` | `false` | `true` |
| URL-bar remote-control icon | none | always |
| Automation prefs on the profile | none | 18 prefs on the default branch while flags are on |
| Persistent content script | none | n/a |
| Page-world globals | none (except during an opted-in `evaluate_script`) | n/a |
| DOM markers / CSS | none, except the opt-out thought bubble's user stylesheet (below) | n/a |
| Synthetic events `isTrusted=false` | yes, during actions only | WebDriver events are trusted |
| Extension fingerprint via `moz-extension://` resource probes | none: no `web_accessible_resources` | n/a |

The `isTrusted=false` line is the one real limitation: interactive bot checks (Turnstile checkbox, "press and
hold") need the user's own click. Passive checks see an ordinary Firefox.

The thought bubble (§7.1) adds no DOM nodes and no page-world script; a MutationObserver sees nothing. A page could
only notice it by probing `getComputedStyle(document.documentElement, "::after")` (or `::before`) during the few
seconds it is shown, and while shown it displaces any content the page itself put on those pseudo-elements.
Turning the option off removes even that.

## 11. Decisions taken

1. Broker lifecycle: on-demand detached spawn by the first MCP process when the socket is absent. No
   `systemd --user` unit.
2. Host grants: per-origin patterns from the options page or the just-in-time popup (§3), plus an optional
   "Grant all sites" (`<all_urls>`) in the options page that is never requested automatically.
3. `evaluate_script`: off by default, enabled by an options toggle; `pageWorld` is a separate per-call opt-in.
4. Screenshots: `tabs.captureTab` with a `rect`, full page capped at 5,000 × 10,000 px; no scroll-stitch. Firefox
   only exposes `captureTab` while the extension holds `<all_urls>`, so screenshots need the all-sites grant.
5. Gecko id: `foxwire@vidr.cc`, fixed by the first signing.
6. Licence: MIT.

## 12. Acceptance test (manual, against the real browser; checklist in `../test/E2E.md`)

1. `status` → paired, grants listed; `list_pages` returns the real tabs.
2. A webmail inbox: `take_snapshot` of the inbox, `click_by_uid` on a thread, `get_page_text`.
3. A site behind Cloudflare bot checks (e.g. claude.ai): load it with the extension connected → **no challenge**
   (the whole point).
4. A legacy ASP.NET form using Infragistics editors: `select_option` on a select that posts back, `type_text` into
   a date editor, `upload_file_by_uid` with a PDF.
5. A shop: add to cart up to the checkout page, stop (payment is the user's).
6. Second MCP client session in parallel: both see the browser; each keeps its own selected tab.
7. Kill the broker mid-call → mcp returns a readable error, next call respawns and reconnects within ~5 s.
8. Firefox restart → extension reconnects on its own; no relaunch flags anywhere (`ps` shows plain `firefox`).
