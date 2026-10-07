# Watches

Watches Beta has an options page and a packaged CLI over the same background
handlers. Read `docs/watch-live-verification.md` for the current observed matrix
and account constraints, and `docs/watch-boundary-coverage.md` for the tests that
own simulated failures and interruptions.

## Built page and CLI

1. Launch the dedicated profile with the existing login, source `session.env`,
   and run doctor. Package tools with `vp run package:tools` before using the
   smoke script. It invokes `artifacts/gramgrab.mjs`, not a source CLI wrapper.
2. Run `node .agents/skills/verify-gramgrab/scripts/watch-smoke.mjs --check
   .local/verify-evidence/run/watch-smoke.json`. The script checks the existing
   official `instagram` Watch, list/needs/inbox count parity, per-kind stderr
   progress, one terminal stdout result, failure exit status, inapplicable
   recovery and unknown-entry refusals. Omit `--check` for read-only page/CLI
   checks. A missing existing Watch fails the requested check.
3. On `chrome-extension://$GRAMGRAB_EXT_ID/options.html`, open Add Watch. Preview
   an existing visible target, verify the disclosure, and verify that Posts and
   Stories start selected and every kind is selectable. Creation stays disabled
   until acknowledgement. An existing target opens its Watch instead of creating
   a duplicate.
4. Use naturally collected entries for `watch inbox export` in Direct, Frame
   and Silent modes, then `watch inbox retry ENTRY_ID PLAN_ID` for failed frozen
   plans. Compare requested/delivered History, preserved accepted siblings and
   page recovery controls. Use `watch needs` attention IDs for retry, dismiss or
   confirm only where that operation is offered. Check problems are not action
   recovery targets. Removal affects inbox metadata only.

## Check now

The Watch detail's Check now state comes from the worker's `watch-scheduler`
record, not from the page. A queued or running manual check is a `manual` job
there, and its last finished one is in `lastManual`. `watch list --json` and
`watch show instagram --json` expose both as `manualCheck` on the Watch summary
(`.watches[]` and `.watch` respectively):
`ManualCheckPending` with `remainingKinds` and `outcomes`, or
`ManualCheckFinished` with `finishedAt` and `outcomes`. The page follows it as
described in Live page below.

1. Clear `instagram-requests` and relaunch, as in Rate-limit pause step 1, so
   the click is not deferred. Open the `instagram` Watch and click Check now.
   The button reads `Checking…` and is disabled, and the line under it lists
   finished kinds and `Still to check: ...`. When pacing stops the check part
   way, the same line adds the reason and time it continues, and that survives
   navigation too.
2. Switch to All inbox and back, then reload `options.html`. Both times the
   button still reads `Checking…` with the same or later progress. A second
   click is impossible while it is disabled. `watch check instagram --json`
   during the check returns `deferredReason: "queued"` and the `manual` array
   in `watch-scheduler` still holds one job for the Watch.
3. Stay on All inbox until `watch show instagram --json` reports
   `ManualCheckFinished`. Poll every 30 seconds at most, since each call makes
   an Instagram request that also delays Watch pacing. A check took 2 to 11
   minutes in live runs, longer while an unattended round shares the queue.
   Return to the Watch: the button reads `Check now` and the line reads
   `Last check ...:` with one outcome per kind. It survives a reload.
4. Click Check now again within five minutes. It returns at once with `Checked
   in the last 5 minutes. Check again at HH:MM.` With a rate-limit pause active
   it says `Instagram rate limited a Watch request. Checks wait until HH:MM.`
   instead, and other spacing reads `Watch requests are spaced out.`

## Live page

An open options page reloads its list, the open Watch and the inbox whenever the
worker writes `watch-store` or `watch-scheduler` in `chrome.storage.local`, or
changes the rate-limit pause in `instagram-requests`. Those reloads go through the
`WATCH_READ` message with the login the page shows. The worker answers without an
Instagram request while that login is still the last one any viewer query found,
and verifies again otherwise. Opening the page, returning to its tab or window,
and every action verify the login once. Tab visibility and window focus events
for one return share a verification. Storage reloads wait for that verification,
and changing the login clears the previous login's selected view and inbox
selections. A signed-out page rechecks on return too. There is no login polling.

1. Read `nextRoundAt`, `remaining`, each kind's `lastCheckAt`, and the length of
   `attempts` in `instagram-requests` from the worker's storage. Open
   `options.html`, leave it on All inbox and screenshot it.
2. Let a round run while the page stays open. A launch on an overdue profile
   starts one after the two-minute startup hold. Otherwise make the deadline
   overdue as in `docs/watch-live-verification.md` step 5: set `nextRoundAt` to
   a past time from the worker. The pump alarm runs every minute. Poll storage
   from the worker, not the CLI, so waiting costs no request.
3. While the round runs, the footer reads `Checking: N left this round`, and the
   row's `Checked` time moves without a reload. When `remaining` is empty, the
   footer reads `Next checks around` the new `nextRoundAt`. Screenshot both.
4. Compare `attempts` with the Watch requests the round made. The page adds
   none. Pause and then resume the Watch from the page: each action adds exactly
   one viewer request, and the reload after it adds none.
5. After the initial load settles, set an in-memory page marker and record the
   request count. Activate a neutral tab, then return to `options.html` without
   reloading. One real viewer request confirms the login; the marker survives.
   Keep the page foregrounded briefly and confirm it adds no further requests.
   Repeat once by moving focus to another browser window and returning, to
   cover the window-focus path. Stop on a 429 or request-cap deferral.
   Follow `docs/watch-live-verification.md` for account changes: use a natural
   switch or sign-out if one occurs, otherwise report that live gap. Focused
   browser-adapter tests own switched-login isolation and sign-out recovery;
   an unchanged real login proves foreground verification, not account switching.

## Posts on a real grid

Instagram's Posts grid is not newest first, and a collab Post can belong to another account. Unit
fixtures cannot show which accounts do this, so prove Posts against a live grid that has it:

1. Pick a target whose first Posts page has pinned Posts (`timeline_pinned_user_ids` holds the
   target), an older Post above a newer one, or a collab whose `user.pk` is another account with
   the target in `coauthor_producers`. The official `instagram` account has none of these, so
   this needs a private target. Check the shape from the worker with a structure-only probe that
   prints booleans, never handles, IDs or media URLs.
2. `gramgrab watch add TARGET --kinds posts --actions collect --accept-unattended --json`, then
   `watch check TARGET --json`. The first check records `KindBaselineRecorded`. A check five
   minutes later runs the page traversal and should report `KindCheckSucceeded` for `posts`, not
   `IG_RESPONSE_SHAPE_UNKNOWN` (collab ownership) or `WATCH_CHECK_INCOMPLETE` (grid order).
3. Screenshot the Watch on the options page, then `watch delete TARGET`. Redact the target and
   the login before a screenshot leaves `.local/`.

A copied profile can carry a rate-limit `pause` in `instagram-requests`, which makes every check
report `deferredUntil` with no kinds run. Clear it as in step 1 of the next section before
judging a check.

## Rate-limit pause

Only a 429 on a Watch request pauses Watches. A person's own request that gets a
429 must not, because Instagram routinely answers `web_profile_info` with 429
and the person's flow falls back to `topsearch`. `scripts/throttle.mjs` answers
the worker's matching requests with a status, so both sides are drivable:

1. Read `instagram-requests` from the worker's `chrome.storage.local`. An
   inherited `pause` comes from earlier runs, so clear the key and relaunch
   before judging, and only on the verification profile.
2. Start `node .agents/skills/verify-gramgrab/scripts/throttle.mjs
   web_profile_info 429` in the background and keep its output.
3. Run `gramgrab inspect instagram --json`. The throttle log shows a 429 for
   `web_profile_info`, the inspect still resolves through `topsearch`, and
   `watch list --json` has no `schedule.pausedUntil`. `watch needs` has no
   `PauseAttention`, and the options page shows no `Watches paused` banner.
4. Stop the throttle. A manual check verifies the viewer once as the person and
   then again as Watch work, through the viewer query
   `d6f4427fbe92d846298cf93df0b937d3` (`operations.viewer` in
   `apps/extension/src/instagram-protocol/config.json`). Start `throttle.mjs
   d6f4427fbe92d846298cf93df0b937d3 429 --pass 1` and run `watch check
   instagram --json`, then stop the throttle at once, since `watch list` and
   `watch needs` verify the viewer too. The log shows one `passed` line, then
   one 429. The Watch request's 429 sets `schedule.pausedUntil` about 30 minutes out, `watch
   needs` has a `PauseAttention` with `IG_RATE_LIMITED`, and the options page
   shows `Instagram rate limited a Watch request`. Without `--pass 1` the
   person's viewer check takes the 429, so the check fails with
   `IG_NOT_AUTHENTICATED` and nothing pauses. Matching a Posts `doc_id` does not
   work either, because Posts requests send it in a POST body. A ledger already
   holding 60 attempts from the last hour defers the check on capacity before
   any Watch request starts, so read `attempts` first and reset as in step 1.
5. Stop the throttle. Clear `instagram-requests` and relaunch, as in step 1.
   Clearing alone is not enough, because the running worker writes its
   in-memory pause back.

Watch checks pace requests and can take minutes. Rerunning inside five minutes
may defer a check; keep that terminal result as evidence. All-digit WATCH values
mean account IDs unless `--username` forces a username. CLI help is the grammar
reference, including explicit Silent re-encode approval.

## Evidence

The smoke script holds CLI responses and identifiers in memory and writes only
booleans and closed failure codes. Keep every other Watch evidence file to the
same contract. Store screenshots in `.local/pr-media/`, and redact the verified login and any
private preview target before attaching them to a
PR. A public official target may appear in PR screenshots, but raw CLI responses,
store dumps, identifiers, captions, session data and signed media URLs do not
belong in the local result files or attachments.

Follow the live procedure for restart, alarm recreation and two-minute catch-up.
Record unrun media, Avatar-change, rename, Instant, Save As and Firefox rows as
accepted gaps. A row that did not run does not disable its kind. Watches remains
Beta in normal releases until Arnab explicitly removes that label.
