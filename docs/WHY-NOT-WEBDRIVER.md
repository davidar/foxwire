# Why not WebDriver

Researched 3 Oct 2026. The goal was to let Claude Code drive the author's daily Firefox session (logins, cookies,
extensions) instead of the ephemeral browser windows that Playwright MCP launches with throwaway profiles. The
obvious route was Mozilla's own MCP server attached to the running browser over WebDriver. It worked, and it was
rejected. This is the record of why; it is the motivation for foxwire.

Machine facts where they matter for the argument: on the author's machine (Fedora, Firefox Flatpak), Firefox 157.0
from Flathub as `org.mozilla.firefox`. The Firefox Flatpak has `shared=network`, so loopback ports opened inside the
sandbox (Marionette 2828, BiDi 9222) are reachable from the host, and an MCP server running on the host via `npx`
can reach them.

## The route: `@mozilla/firefox-devtools-mcp` with `--connect-existing`

Official Mozilla project (github.com/mozilla/firefox-devtools-mcp), MIT OR Apache-2.0, v0.10.4 published
22 Sep 2026. It uses WebDriver Classic (Marionette) plus WebDriver BiDi and offers Playwright-style tools
(accessibility snapshot, click/fill/drag, tabs, network and console capture, screenshots). Tool presets are
`slim < basic (default) < developer < mozilla < all`; `developer` adds script execution and debugging (Firefox 153+).

From its README, "Connect to existing Firefox": "Use `--connect-existing` to automate your real browsing session,
with cookies, logins, and open tabs intact." Both flags are required on the Firefox side; with only `--marionette`
the server "fails to connect and asks you to restart Firefox with both flags."

**Mozilla's warning (verbatim, from the same README):** "Do not leave Marionette enabled during normal browsing. It
sets `navigator.webdriver = true` and changes other browser fingerprint signals, which can trigger bot detection on
sites protected by Cloudflare, Akamai, etc. Only enable Marionette when you need MCP automation, then restart
Firefox normally afterward." And from its security section: "Never run the server against your regular profile —
the agent has access to whatever the browser can reach, including cookies and saved sessions."

### Recipe

1. Quit Firefox. The flags are ignored if an instance is already running; the Flatpak just hands the arguments to it.
2. Relaunch with the two flags:
   `flatpak run org.mozilla.firefox --marionette --remote-debugging-port`
   (default ports 2828 / 9222; session restore brings the tabs back).
3. Register the server once, at user scope:
   `claude mcp add -s user firefox -- npx -y @mozilla/firefox-devtools-mcp@latest --connect-existing`
   (add `--tool-preset developer` if JavaScript evaluation is wanted).
4. The `mcp__firefox__*` tools then drive the running browser. When done, quit Firefox and reopen it normally to drop
   the WebDriver flag.

A second desktop launcher that appends `--marionette --remote-debugging-port 9222` to the `Exec=` line (before
`@@u %u @@`; an explicit port so a following URL isn't taken as the port value) makes the relaunch one click.

## Alternatives looked at at the time

- **Blueprint MCP for Firefox** (AMO, v1.9.22, 10 Aug 2026, 94 users; server `@railsblueprint/blueprint-mcp`,
  WebSocket localhost:5555, PRO tier adds a cloud relay). Always on, no WebDriver flag, signed, but a small
  commercial vendor's extension with "Access your data for all websites" in the browser that holds every session.
- **foxcode** (github.com/korchasa/foxcode, v0.23.0, MIT): WebExtension plus Claude Code plugin, single
  `evalInBrowser` tool. Not on AMO, so release Firefox only loads it as a temporary add-on, which is dropped on
  every restart.
- **ClaudeCodeBrowser** (AMO, nanogenomic): screenshot/click/type via an extension; thinner tool set.
- **Claude in Chrome**: a real logged-in browser, but Chrome, not Firefox.
- Playwright MCP cannot attach to stock Firefox (its Firefox is a patched build; BiDi attach is experimental).

`docs/PRIOR-ART.md` is the fuller extension survey made afterwards.

## First live test: it works, with two gotchas

With Firefox relaunched with the flags, `ps` showed `firefox --marionette --remote-debugging-port 9222` and `ss`
showed 127.0.0.1:2828 and :9222 listening. A manual run of the server over stdio JSON-RPC (`list_pages`) returned
the real session's tabs. Problems seen from Claude Code:

1. **`get_firefox_info` crashes the server in `--connect-existing` mode** ("Cannot read properties of null
   (reading 'close')"; it assumes a launched Firefox process). Claude Code respawns the server, but see 2.
   In attach mode, `list_pages` is the health check.
2. **A crashed server leaves its geckodriver holding Marionette.** Marionette accepts one client. The respawned
   server's new geckodriver (`geckodriver --connect-existing --marionette-port=2828`, v0.37.1 bundled by the npm
   package) hung about 60 s on `list_pages`, returned "unknown error", and dumped core (SIGABRT). Fix:
   `pkill -f '^node .*firefox-devtools-mcp'; pkill -f 'geckodriver --connect-existing'` (anchor the node pattern;
   a bare `pkill -f firefox-devtools-mcp` matches the shell running it), confirm with
   `ss -tnp | grep -E ':(2828|9222) '` that nothing is ESTAB, then reconnect the server with `/mcp`.
3. Killing the server from inside a Claude Code session marks it disconnected for that session; `/mcp` → reconnect
   (or a new session) brings the tools back.

Other notes: `DEBUG='*' … --logFile <path>` gives the verbose log, which streams every tab's console output and
network requests. After the first attach, `prefs.js` carried `remote.prefs.recommended.applied = true`: Marionette
had applied its recommended automation prefs to the real profile, which is the fingerprint change Mozilla warns
about.

## Bot detection

With the flags on, claude.ai showed a Cloudflare "Just a moment…" challenge and would not accept the captcha.
Firefox also showed the remote-control robot icon in the URL bar for the whole session.

### How Marionette alters the signals (read from mozilla-central tip, 3 Oct 2026)

- **`navigator.webdriver`**: `dom/base/Navigator.cpp` `Navigator::Webdriver()` asks the Marionette service and then
  the RemoteAgent service for `isBrowserAutomationRunning`; it is true if either says yes. It is not a pref and
  cannot be turned off while a command-line-started Marionette is listening. A live check in the attached session
  returned `webdriver: true`. `isBrowserAutomationRunning = running && #isBrowserAutomation`, and
  `#isBrowserAutomation` is `true` for command-line startup (`remote/components/Marionette.sys.mjs`). The flag is
  also pushed to every content process via sharedData.
- **Recommended automation prefs**: `remote/shared/RecommendedPreferences.sys.mjs`, 18 prefs applied on the DEFAULT
  branch when a WebDriver session starts (never written to `prefs.js`): Safe Browsing phishing/download checks off,
  health report and usage upload off, credit-card autofill off, `dom.max_script_run_time` 0, process-priority
  manager off, `dom.input_events.security.minTimeElapsedInMS` 0, system add-on updates off, and others. They stay in
  force for normal browsing while the flags are on. `remote.prefs.recommended = false` disables applying them.
- **URL-bar robot**: `browser/base/content/browser.js` `gRemoteControl.getRemoteControlComponent()` returns
  "Marionette" whenever `Marionette.running` is true. It is keyed on the server listening, not on automation mode,
  so no Mozilla-sanctioned mode hides it.

### Mozilla's intended fix: "dynamic start" (not reachable on release 157 yet)

`remote.experimental.dynamicstart.enabled` defaults to false. Its `all.js` comment reads: "built for AI Assistant
integrations (e.g. Claude cowork). On Nightly, enabling this preference will enable the Remote Control panel. On
other channels, there is no user facing entry point for now."
`browser/components/remotecontrol/RemoteControlServers.sys.mjs` (shipped in 157's omni.ja) calls
`RemoteAgent.startAtRuntime({isBrowserAutomation:false})` and
`Marionette.startAtRuntime({isBrowserAutomation:false, portFilePath: ~/.firefox-devtools-mcp/instances/…})`. The
servers run but `navigator.webdriver` stays false; a connection prompt (`…dynamicstart.prompt.enabled`) and an
infobar banner show instead, and the servers can be stopped at runtime. The Nightly-only toolbar button and panel
(`RemoteControlPanel.sys.mjs`, gated on `AppConstants.NIGHTLY_BUILD`) are not in 157. On release the only trigger is
privileged JS in the Browser Console
(`ChromeUtils.importESModule("moz-src:///browser/components/remotecontrol/RemoteControlServers.sys.mjs").RemoteControlServers.start()`)
after flipping the pref, and `@mozilla/firefox-devtools-mcp` 0.10.4 has no port-file support (nothing in its
`dist/` or README), so it would need `--marionette-port <from the port file>` and the dynamic BiDi port by hand.
Worth watching for the panel reaching release.

## Decision

The WebDriver flags went back off by default, with the flagged launcher kept separate: quit Firefox, open the agent
launcher, let Claude drive, quit, reopen normally. Spoofing `navigator.webdriver` was rejected: it is exactly what
Cloudflare's challenge probes, and it would be an arms race against the sites in use.

Relaunching the browser every time to toggle automation turned out to be worse in practice than a separate
automation browser, so an extension-based driver was the remaining option: no WebDriver, no flag, no robot icon.
The survey in `docs/PRIOR-ART.md` compared the existing extensions; none combined a small reviewable codebase,
authenticated loopback pairing and no persistent page injection, so foxwire was written on the same architecture
and self-signed as an unlisted add-on, so that no third-party auto-update reaches the browser that holds every
session.
