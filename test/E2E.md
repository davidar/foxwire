# foxwire — manual acceptance checklist (DESIGN §12)

Run this against the real browser after `npm run build`, the extension loaded (temporary via `about:debugging`,
or the signed xpi), and the secret pasted into its options. Tool calls are as made from Claude Code with the
server registered as `foxwire` (so `mcp__foxwire__<tool>`). Tick each box; note failures with the error code.

## 0. Preflight

- [ ] `npm run typecheck && npm test && npm run lint` all pass (lint: 0 errors).
- [ ] `ps -o args= -C firefox | head -1` shows plain `firefox`: no `--marionette` or `--remote-debugging-port`.
- [ ] `scripts/install-mcp.sh` has been run; `claude mcp list` shows `foxwire` connected.
- [ ] Options page grants made for the test sites below: a webmail inbox, a site behind Cloudflare bot checks
      (e.g. `claude.ai`), a form with Infragistics editors (if available), and a shop.

## 1. Status and tabs

- [ ] `status` → `paired: yes`, extension and Firefox versions are right, `grants` lists the origins above,
      `evaluateEnabled: false` (the default).
- [ ] `list_pages` → matches the real tab strip (titles, URLs, the active tab).
- [ ] `select_page {"title": "<part of a tab title>"}` → that tab; `list_pages` marks it selected.
- [ ] `take_snapshot` on a tab whose origin is NOT granted → error code `NO_GRANT` naming the origin
      (nothing is widened, no permission prompt appears).

## 2. Webmail inbox

- [ ] `select_page {"url": "<mail host>"}` (or `new_page {"url": "https://<mail host>/", "wait": "complete"}`).
- [ ] `take_snapshot` → inbox rows appear with `uid=` on threads.
- [ ] `click_by_uid {"uid": "<a thread row>"}` → the thread opens.
- [ ] `get_page_text {"maxLength": 4000}` → the thread's text.
- [ ] `navigate_history {"delta": -1}` → back in the inbox; a uid from step 2 now fails with `STALE_UID` (or still
      resolves if the app kept the element; either is acceptable, a hang is not).

## 3. A site behind Cloudflare bot checks — headline test

- [ ] With the extension connected, `new_page {"url": "<a Cloudflare-fronted site, e.g. https://claude.ai/new>", "wait": "complete"}`.
- [ ] `get_page_text {"maxLength": 2000}` → the site's own UI text, **not** a Cloudflare "Verify you are human" or
      "Just a moment…" page. Also confirm by eye: no challenge, no URL-bar robot icon.
- [ ] In a granted tab, the devtools console shows `navigator.webdriver === false`.
- [ ] `screenshot_page` → a PNG of the page (needs "Grant all sites").

## 4. Infragistics editors (legacy ASP.NET form) — second headline test

- [ ] `take_snapshot` on the form → Infragistics editors and selects have uids.
- [ ] `select_option {"uid": "<category select>", "values": ["<label>"]}` → the postback fires and the dependent
      fields refresh (re-`take_snapshot` to see them).
- [ ] `type_text {"uid": "<date editor>", "text": "03/10/2026"}` → the editor shows the date, and it survives
      blur (`press_key {"key": "Tab"}`) without reverting. (If `fill_by_uid` was tried first and reverted, note it.)
- [ ] `upload_file_by_uid {"uid": "<file input>", "paths": ["/abs/path/file.pdf"]}` → the form shows the
      file attached.
- [ ] Do not submit unless the user says so.

## 5. Shop checkout

- [ ] `new_page {"url": "https://<a shop>/", "wait": "complete"}`, search via `fill_by_uid` +
      `press_key {"key": "Enter"}`, open a product with `click_by_uid`.
- [ ] `click_by_uid` on "Add to Cart", then proceed to checkout. **Stop at the checkout page**; payment is the user's.
- [ ] `wait_for {"text": "Checkout", "timeoutMs": 20000}` returns before the timeout.

## 6. Two Claude Code sessions in parallel

- [ ] Start a second Claude Code session. Both: `status` → `paired: yes`.
- [ ] Session A: `select_page {"idx": 0}`. Session B: `select_page {"idx": 1}`.
- [ ] Each session's `get_page_text` returns its own tab's text; neither's selection moved.

## 7. Broker killed mid-call

- [ ] Start `wait_for {"text": "never-appears-xyz", "timeoutMs": 30000}`, then from a shell kill the broker
      (`pkill -f foxwire.*broker`).
- [ ] The tool returns a readable error with a named code (`NO_BROKER` or `NOT_PAIRED`), not "unknown error" and
      not a hang.
- [ ] The next `status` call respawns the broker; within ~5 s `status` → `paired: yes` again.

## 8. Firefox restart

- [ ] Quit and restart Firefox normally, without any remote-control flags.
- [ ] Without touching anything, `status` → `paired: yes` within ~10 s of the window appearing.
- [ ] `ps -o args= -C firefox | head -1` still shows no remote-control flags.

## 9. Thought bubble and toolbar popup

- [ ] On a granted page, `take_snapshot`, then `click_by_uid {"uid": …, "intent": "Testing the bubble"}` → a dark
      rounded bubble "🦊 Testing the bubble" appears next to (above, or below near the top) the element, tail toward it.
- [ ] `navigate_page {"url": …, "intent": "Going home"}` → the bubble shows bottom-centre on the new page.
- [ ] Each bubble disappears ~4 s after its call returns.
- [ ] While one shows, in the page's devtools console `document.querySelectorAll("*").length` equals the count taken
      before the call.
- [ ] `screenshot_page {"intent": "Checking layout"}` right after a bubbled click → the bubble is not in the image.
- [ ] The foxwire toolbar button's popup lists the calls newest first (intent, tab title, red code on failures);
      clicking an entry focuses that tab. The `status` tool prints `bubbleEnabled: true`.
- [ ] Untick "Show Claude's thought bubble" in options → repeat the click with an intent → no bubble; the popup still
      lists the call; `status` prints `bubbleEnabled: false`. Tick it again.

## 10. Just-in-time site grants

- [ ] Remove the grant for a test site in options. `navigate_page` there, then `take_snapshot {"intent": "Reading
      the page"}` → the toolbar badge turns to an orange `?` (tooltip "Claude wants access to https://…"); the popup
      (opened by itself, or by clicking the button) shows the origin, the exact `https://host/*` pattern, the intent
      and the tab title, with Allow and Deny.
- [ ] Allow → Firefox's own permission prompt names that one site; accept → the same `take_snapshot` call completes
      (no retry by the model) and its output starts with `note: the user granted https://host/* when asked`. The badge
      clears; options lists just that pattern.
- [ ] Remove the grant again; repeat; Deny → `NO_GRANT` "declined" at once. Repeat the call immediately →
      `NO_GRANT` at once ("declined … in the last 10 minutes"), no new popup entry.
- [ ] On a third site, ignore the request → `NO_GRANT` after ~60 s saying it is still shown in the popup; Allow it
      within 2 minutes → the next call works without asking.
- [ ] Without "Grant all sites", `screenshot_page` on a granted site → `NO_GRANT` about all sites; no `?` badge.

## 11. Uid generations and change waits

- [ ] `take_snapshot` of a page and note a uid (e.g. `37kqx`). Reload the extension (or the page) without closing the
      tab, then `click_by_uid` with the old uid → `STALE_UID` saying the page or extension reloaded; nothing is
      clicked. A fresh `take_snapshot` shows uids with a different three-letter tag.
- [ ] On a chat-like page (e.g. a claude.ai conversation), send a message, then `wait_for {"change": true,
      "selector": "<the message list>", "timeoutMs": 60000}` → `changed after … ms:` followed by the new reply text,
      not the whole thread. With nothing happening, the same call → `TIMEOUT` "nothing changed".

## 12. Ergonomics

- [ ] On a page with a third-party chat widget in an iframe: `take_snapshot` → the widget's iframe line shows
      `[frame=f1 https://…]` and its uids read `f1_…`. Navigate the tab elsewhere and back, then use an old `f1_…`
      uid → `STALE_UID`.
- [ ] `get_page_text {"selector": "<a message list class inside the widget>"}` → `matched N element(s) in frame f1
      https://…` and the full message text; a selector that matches nothing → `BAD_PARAMS` "matched nothing in any
      frame". `get_page_text {"uid": "<a row uid>"}` → that row's full text.
- [ ] `type_text {"uid": "<the message box>", "text": "hello", "submit": true}` → `… and pressed Enter` and an
      `after:` line showing the sent message (and `… emptied` if the box cleared).
- [ ] `click_by_uid` on something with no visible effect (e.g. a blank area with a tabindex) → `after: no visible
      change within 400 ms`. `click_by_uid` on a plain link to another page → `after: the page navigated or the frame
      was replaced` within ~2.5 s, not `TIMEOUT`.
- [ ] `wait_for {"selector": "<a row class>"}` → `appeared after … ms (N matches, top frame)` or the frame alias.
      `wait_for {"change": true}` on a tab whose title changes on a new message → `(title: "…")` in the output.
- [ ] `list_pages {"filter": "mail"}` → `N of M tabs match` with the same idx numbers as the unfiltered list;
      `sleep {"ms": 1500}` → `slept 1500 ms`.
- [ ] On a combobox whose popup is open, `take_snapshot` shows `controls=<uid>` on it.

## 13. Field-report fixes

- [ ] A form with `<input readonly>` and a disabled `<fieldset>`: `take_snapshot` shows `readonly` / `disabled`.
- [ ] `click_by_uid` on a `target=_blank` link → `after: opened tab <id> (<url or loading>)`.
- [ ] A page with an ungranted Stripe iframe: its snapshot note shows `https://js.stripe.com/v3/…?…`, not the fragment.
- [ ] `wait_for {"change": true, "timeoutMs": 4000}` on a quiet page → `TIMEOUT` "… within 4000 ms".

## 14. New-tab links and labels

- [ ] `click_by_uid` on `<a href="/t2.html" target="_blank">` → `after: opened tab <id> (…/t2.html) [link target=_blank]`,
      exactly one new tab, next to the opener. With pop-ups allowed for the site → one tab, no `[link target=…]`.
- [ ] A link whose click handler calls `preventDefault()` → no tab opened.
- [ ] `fill_by_uid` on a `<label>`'s uid → the note names its `<input>`; on a readonly input → `BAD_PARAMS … is readonly`.

## Optional

- [ ] `evaluate_script {"function": "() => document.title"}` → `DISABLED` while off; enable it in options, retry →
      the title; switch it off again afterwards.
- [ ] `handle_dialog {"accept": false}` then `click_by_uid` on something that calls `confirm()` → the click's result
      reports the swallowed dialog; a second `confirm()` afterwards shows normally (handler not left installed).
