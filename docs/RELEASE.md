# foxwire — release, install, undo

The first signed build was 0.1.0 on 3 Oct 2026 (unlisted channel; signing took about five minutes). The facts below
come from that run, on Linux with the Firefox Flatpak.

## Dev loop (no signing)

1. `npm run build && npm run typecheck && npm run lint && npm test`.
2. If Firefox is a Flatpak, it cannot read most of your home directory, so stage a copy it can read:
   `rsync -a --delete --exclude '*.ts' --exclude '.amo-upload-uuid' extension/ ~/Downloads/foxwire-ext/`
   (Alternative, which needs a Firefox restart:
   `flatpak override --user --filesystem=/path/to/foxwire:ro org.mozilla.firefox`.)
   With a non-Flatpak Firefox, load `extension/` directly.
3. `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `~/Downloads/foxwire-ext/manifest.json`.
   A temporary load with the same id overrides an installed signed build until Firefox restarts.
4. After later rebuilds, stage again, then reload: either **Reload** on the foxwire card in `about:debugging`, or the
   broker-only `reload` method (`{"method":"reload"}` over the broker's Unix socket; not an MCP tool), which calls
   `runtime.reload()`. Reload keeps storage and grants. On a signed install it only restarts the same signed code.
   Inject bundles are read from disk per call, so they change as soon as they are staged; `background.js`, the
   popup, the options page and the manifest change only on reload.
5. MCP server changes (`mcp/`) need a new MCP client session or a reconnect (`/mcp` in Claude Code). Broker changes
   need the broker restarted (`pkill -f broker/dist/broker.js`; the next MCP call respawns it).

**Do not click Remove on a temporary add-on unless you mean it.** Remove is an uninstall: Firefox deletes the
extension's storage (pairing secret, port, toggles) and its optional host permissions. This happened when moving
from the temporary load to the signed 0.1.0, and the secret and grants had to be entered again.

## Signing (your command; keys never enter an agent's context)

**If you are signing your own copy or a fork, change the gecko id first.** `browser_specific_settings.gecko.id` in
`extension/manifest.json` is `foxwire@vidr.cc`, which is tied to the author's addons.mozilla.org (AMO) account. AMO
will refuse to sign that id for anyone else. Use an id under a domain or address you control, such as
`foxwire@example.org`.

One-time: create an API key pair at <https://addons.mozilla.org/en-US/developers/addon/api/key/> and store it
privately:

    install -m 600 /dev/null ~/.config/foxwire/amo.env
    $EDITOR ~/.config/foxwire/amo.env      # export AMO_JWT_ISSUER='user:…'  /  export AMO_JWT_SECRET='…'

Each release, in your own terminal:

    # first bump the version in extension/manifest.json, package.json (npm version X --no-git-tag-version),
    # mcp/server.ts and README.md
    source ~/.config/foxwire/amo.env && scripts/sign.sh

- The script builds, runs `web-ext sign --channel unlisted`, waits for automated review, and saves the signed
  file as `web-ext-artifacts/<hash>-<version>.xpi`.
- A version number can be signed once. Re-running with the same version is rejected; bump it.
- If `web-ext` stops waiting (about 15 minutes), do not re-run. Download the xpi from the Developer Hub:
  My Add-ons → foxwire → Manage Status & Versions → the version.
- The first signing ties the gecko id to your Mozilla account. `extension/.amo-upload-uuid` is web-ext's
  bookkeeping and is git-ignored.
- `web-ext lint` reports `DANGEROUS_EVAL` for `dist/inject/evaluate.js` (the opt-in `evaluate_script`). It did
  not hold up 0.1.0.

## Install

1. With the Flatpak, copy the xpi somewhere Firefox can read: `cp web-ext-artifacts/*-<version>.xpi ~/Downloads/`.
2. `about:addons` → gear → **Install Add-on From File** → the xpi. Installing over an existing signed build of
   the same id is an update and keeps storage and grants.
3. If this is the first install, or a temporary add-on was removed first: open the foxwire options page, paste
   the pairing secret, Save, and re-grant sites. On Wayland, `wl-copy < ~/.config/foxwire/secret` puts it on the
   clipboard without printing it.
4. Check: the options page shows "paired with broker"; the `status` tool shows `paired: yes` and the version.

Unlisted builds never auto-update (no `update_url`); what is installed is what was signed.

## MCP server and broker

- `scripts/install-mcp.sh` registers `foxwire` with Claude Code at user scope; `scripts/uninstall-mcp.sh` removes it.
- The broker is spawned on demand by the MCP server (log: `~/.config/foxwire/broker.log`), or by hand with
  `npm run broker`. It does not survive a reboot; the next tool call starts it again.

## Undo

- Extension: `about:addons` → foxwire → Remove.
- MCP: `scripts/uninstall-mcp.sh`.
- Broker: `pkill -f broker/dist/broker.js`; delete `~/.config/foxwire/` to drop the secret, log and AMO keys.
- Staged copy: `rm -r ~/Downloads/foxwire-ext`. Flatpak override, if set:
  `flatpak override --user --reset org.mozilla.firefox`.
- AMO: revoke the API key on the key page; the add-on can be deleted from the Developer Hub.
