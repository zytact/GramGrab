# Watches

Watches Beta has an options page and a packaged CLI over the same background
handlers. Read `docs/watch-live-verification.md` for the current observed matrix
and account constraints, and `docs/watch-boundary-coverage.md` for the tests that
own simulated failures and interruptions.

On a shared real account, preserve `instagram-requests`, including inherited
pauses and attempt counts. Use existing discoveries and the page's storage
updates. A 429 or request-cap deferral is evidence to report, not a reason to
retry or reset the ledger. Do not force scheduling deadlines into the past.
Check-now, fault-injection and repeated-check recipes
below require an isolated QA account and a separately authorized run.

## Profile link

1. Open `options.html` and select the existing `instagram` Watch in the sidebar.
   The username heading is an underlined `a.opt-profile-link` whose `href` is
   `https://www.instagram.com/instagram/`. Capture the heading with the verified
   login hidden.
2. Click the heading. Require a new Instagram profile tab and an unchanged
   options-page URL with the Watch still selected. Close only the new tab.
3. Return to the options page. Use `node $D key options.html Tab` until
   `document.activeElement.matches('a.opt-profile-link')`. Require
   `:focus-visible` and a visible outline, then capture the focused heading.
   `node $D key options.html Enter` must open the same profile in a new tab.
   Close the new tab afterward.
4. Switch to All inbox and back. The link returns with the selected username's
   profile URL. If another Watch exists, select it and require both the heading
   and destination to follow that Watch. Record a missing second Watch as a
   live prerequisite rather than changing stored usernames to simulate one.

## Sidebar heading

The `WATCHES (N)` heading above the sidebar's Watch rows is a
`.opt-label.opt-section` span. It is smaller than the 12px rows and uses
`--text-mid`, which reads at about 5.4:1 on the dark `--surface` sidebar and
5.8:1 in the light theme. WCAG AA needs 4.5:1 at this size.

1. Open `options.html`. Read the heading's computed `color` and `font-size`,
   and the `background-color` of `nav.opt-list`, and compute the contrast ratio
   from those values. Require at least 4.5:1 and N equal to the Watch count.
2. Screenshot the page and crop the full sidebar width to the heading's
   bounding box plus a small margin, so no username or Avatar is in frame.
   That crop may leave `.local/`.

## Inbox preview

Story entries show [expiry](./story-expiry.md) in Found and both inbox views
before media is fetched. Preview cards show the same deadline after fetching.
The label refreshes each minute and becomes `Expired`; the 30-day inbox
retention notice remains a separate deadline.

1. Open All inbox or a Watch's Inbox tab and tick a naturally collected entry's
   `Select inbox item` checkbox. Click `Fetch media`. Require a rendered image or
   playable video with real dimensions, not merely a mounted media element.
   Capture a screenshot with the verified login hidden. A fresh preview must
   leave browser downloads, History and Workspace draft/transfer state unchanged.
2. Use the shared card's `Select item NN`, `Frame`, `Remove audio` and
   `Rotate item NN` controls. Deselecting every card disables download. Frame and
   Silent are mutually exclusive. Frame download waits for measured metadata;
   its slider and video `currentTime` must agree at a nonzero timestamp. Rotate
   and check the preview's orientation and aspect ratio before download.
3. Download Original, Frame and Silent from the same recorded entry, fetching
   again only when needed. Require completed, nonempty files; check the Frame
   JPEG against its requested timestamp/rotation and the Silent MP4 with
   `ffprobe` for video without audio. Use the actual re-encoding consent dialog
   if offered. Compare delivered identities with the recorded reference in
   memory, saving equality booleans rather than IDs or URLs.
4. Learned unavailable reasons remain on the discovery row when selection
   changes. An available Sidecar child keeps its recorded ordinal when another
   child is missing or deselected. Avatar cards offer Original only, without
   Frame, Silent or rotation. Use natural entries for these routes; missing
   Avatar changes, Sidecars or expired entries are explicit live prerequisites,
   with adapter boundaries owned by the focused tests.
5. Navigate away and back, then reload once. Preview media and settings must
   clear without becoming a Workspace draft. Actual downloads create ordinary
   History receipts and keep discoveries in the inbox. A verified-login change
   clears the previous owner's preview, including late asynchronous replies.
   Exercise this only when a natural account switch occurs.

Preserve completed files outside `.local/verify/` before cleanup if a reviewer
must inspect their bytes. Keep evidence names free of identifiers; never save
raw store or CLI dumps for these checks.

## Bulk removal

Removal deletes inbox metadata only. The discovery stays, so its media is never
found again, and the Watch stays enabled. Natural entries are precious on a
shared account, so drive this on synthetic entries only with the user's
authorization, and label any screenshot as synthetic.

1. In All inbox and in a Watch's Inbox tab, `Remove selected (0)` starts
   disabled. `Select all` ticks every `Select inbox item` checkbox, including
   unavailable entries. `Clear selection` unticks them all.
2. Select all, untick one entry, click `Remove selected (N)`. Require exactly
   the ticked entries gone, the unticked one still listed, and the Watch's
   `enabled` flag unchanged in `watch-store`.
3. With only unavailable entries ticked, `Fetch media` is disabled while
   `Remove selected (N)` stays enabled.
4. A Select all over an entry with a saved failed export shows
   `Retry failed exports`, the same as ticking it alone.

Storage-write failures keeping the selection belong to `watches.test.tsx`.

## Long Watch list

The options page is three fixed-height panes. The Watch list, the feed and the
inspector each scroll on their own, and the document itself never scrolls. The
header, Needs you, All inbox, the Watches label and `+ Add Watch` stay in place
however long the list is. Below about 500px of height the list keeps a 120px
floor and the whole sidebar scrolls instead.

1. A long list needs more Watches than a shared account should check. Seed
   paused local fixtures on the verification profile only:
   `node .agents/skills/verify-gramgrab/scripts/watch-fixtures.mjs seed 12`.
   They copy the first Watch's viewer, are disabled, and are never checked.
   Run `watch-fixtures.mjs remove` in a `finally` step. It deletes only Watches
   whose target ID has the fixture prefix, so it works after a relaunch.
2. Open `options.html`, select a Watch, and wheel over `.opt-watch-list` with
   CDP `Input.dispatchMouseEvent`. Require `document.scrollingElement.scrollTop`
   to stay `0` with `scrollHeight === innerHeight`, `.opt-watch-list` to scroll,
   and `.opt-head` and `.opt-add-item` to keep their positions.
3. Click `+ Add Watch` while the list is scrolled. The `Add Watch` heading, the
   account input and `Find account` must sit inside the viewport with no scroll.
4. Select a fixture Watch, which has 40 discoveries, and wheel over
   `.opt-feed`. The feed scrolls and the sidebar does not move.

Use the window's own viewport. In this environment
`Emulation.setDeviceMetricsOverride` makes wheel events hang, and so does a
window shorter than about 500px, so read short-height layout from element
metrics rather than wheel input. A `hidden` page also hangs input and
screenshots. Run `drive.mjs activate options.html` first.

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

1. Read the inherited request ledger first. If checks are deferred, preserve
   that result and stop this recipe. Open the `instagram` Watch and click Check now once.
   The button reads `Checking…` and is disabled, and the line under it lists
   finished kinds and `Still to check: ...`. When pacing stops the check part
   way, the button reads `Waiting…` until that time, the same line adds the
   reason and time it continues, and that survives navigation too.
2. Switch to All inbox and back, then reload `options.html`. Both times the
   button still reads `Checking…` (or `Waiting…` while held) with the same or
   later progress. A second
   click is impossible while it is disabled. `watch check instagram --json`
   during the check returns `deferredReason: "queued"` and the `manual` array
   in `watch-scheduler` still holds one job for the Watch.
3. Stay on All inbox until storage reports `ManualCheckFinished`, using the
   live page or a bounded worker-storage wait. CLI Watch reads verify the viewer
   and consume requests, so they are not a polling mechanism. A check took 2 to 11
   minutes in live runs, longer while an unattended round shares the queue.
   Return to the Watch: the button reads `Check now` and the line reads
   `Last check ...:` with one outcome per kind. It survives a reload.
4. Click Check now again within five minutes. It returns at once with `Checked
   in the last 5 minutes. Check again at HH:MM.` With a rate-limit pause active
   it says `Instagram rate limited a Watch request. Checks wait until HH:MM.`
   instead, and other spacing, the hourly cap included, reads `Watch requests
   are spaced out.`

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
The page also follows the `watch-viewer` key in `chrome.storage.session`, which
every viewer query writes, including the CLI's. When the key is removed, the page
drops to the sign-in gate without a request. When it names another login, the
page verifies once. Chromium fires no change event when a query rewrites the
same login.

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
6. With a page marker set, record the request count and run
   `gramgrab watch list` once. The count grows by exactly the CLI's one request,
   and the page keeps its marker and console. To drive the page's login-loss
   path without signing out, run
   `chrome.storage.session.remove('watch-viewer')` from the worker, which is
   what a viewer query that finds no login does. The page shows `Sign in to
   Instagram` with the stored count, keeps its marker, and adds no request.
   Return to the tab: one viewer request restores the console. This injects
   session state only. A real sign-out stays a reported live gap.

## Avatars

The options page shows an Avatar beside the Instagram login at the top of the
sidebar, beside each Watch in the sidebar list, and beside the username in an
open Watch's header. Each one is an `img.opt-avatar`, or a `span.opt-avatar`
holding the username's first letter while no picture exists.

Initials have a muted fill and a thin dashed ring. Watch initials carry the
tooltip and accessible image label `Initials stand in for pictures. Pictures
update during Watch checks.` The login's hint is only `Initials stand in for
pictures.` A sidebar footer shows the full Watch explanation once the initial
cache read has finished and any Watch lacks a cached picture. It disappears
when every Watch has a cached picture; an empty Watch list shows no note.
Opening the page does not start an Avatar lookup.

- A Watch's picture is cached on its Watch record as `avatarImage` (`pictureId`,
  base64 `jpeg`, `checkedAt`). The JPEG is 80 by 80 pixels, capped at 8 KiB
  decoded bytes. It is written after a check, never on page open. A
  Watch of Avatar changes reuses the identity its check read and loads the image
  only when that identity changes. Any other Watch spends at most one `topsearch`
  request a week, including failed attempts, tracked by `avatarLookupAt`. An
  initial image can use this lookup after a partial check that omitted Avatar.
  A failed Avatar step does not repeat the same lookup. Request-cap deferrals
  leave the timestamp unchanged. The timestamp must fit before a request starts.
  An optional image that exceeds the 2 MiB store budget is skipped without a
  storage warning. A check that loses login verification does not refresh images.
  Ownership is checked after request spacing. An unspent lookup cancelled by a
  login change leaves the cooldown unchanged.
- The login's picture comes from successful viewer queries, is held in worker
  memory, and is never stored. Opening the page costs no extra Instagram request
  for it. The open page keeps its login image across empty cache reads after a
  worker restart, until a viewer query repopulates worker memory.

1. Read the store from the worker as booleans only: whether each Watch has
   `avatarImage` and the `jpeg` length. Never print the base64 or the IDs.
2. Open `options.html`. With no `avatarImage` yet, the row and header show the
   initial. Open the Watch by its sidebar button and confirm its account and
   status remain the button's accessible name. The row and header initials
   have the full Watch hint in `title` and `aria-label`, and their computed
   `border-style` is `dashed`. The footer explanation appears once, above the
   next-check time. It is muted, rather than a warning. A pending initial cache
   read shows no footer explanation; the focused Watches UI test owns that
   delayed-response boundary.
   Reuse an already queued check or let the natural round run. Check now
   requires the separately authorized QA run described above. After a picture
   arrives, the row and header show
   `img.opt-avatar` with a `data:image/jpeg` source, and `avatarImage.jpeg` is at
   most 10924 base64 characters. If every Watch is now cached, the footer note
   disappears without reloading. Images retain the solid border and have no
   placeholder hint. For UI-only cache transitions, a temporary local fixture
   is also valid: retain the original image in page memory, scale a packaged
   icon into a bounded 80 by 80 JPEG, and set only the official Watch's
   `avatarImage` with a unique synthetic picture identity. Label the proof as a
   seeded local cache, never as Instagram acquisition. In a `finally` step,
   restore the original image only if the current image still has that fixture
   identity. Preserve any real replacement and read the latest store so other
   fields stay current. Keep lookup timestamps and the request ledger unchanged.
   The focused UI test covers this transition too.
3. Reload `options.html` and compare `attempts` in `instagram-requests` before
   and after. The reload adds one attempt, the viewer query, and nothing for
   Avatars.
4. A copied profile's Watch may already hold `avatarImage`, or a queued check.
   Record that first and reuse the existing check. Do not repeat Check now,
   clear the request ledger, or poll with commands that verify the login. On a
   real 429 or cap deferral, stop and report it. Wait for completion through
   worker storage events or read-only state, with a bounded timeout.
5. To prove the render fallback, temporarily set the row image's `src` to an
   invalid local JPEG data URL. The browser decode error reaches `onError` and
   renders the initial with its dashed border, tooltip and accessible label.
   This does not remove the cached image, so the footer still follows cache
   availability. Keep the store untouched. Label this as a browser
   image-error check, then reload to restore the normal image.
6. Keep the options page open while stopping only this extension's worker through
   CDP. After restart, a store-driven read keeps the displayed login image and
   adds no request. Use `Target.closeTarget` if `ServiceWorker.stopWorker` is
   unavailable. Delete the Watch through its confirmation UI and confirm both
   the Watch record and its cached image are gone.

## Notification Avatar

Every Watch notification uses the same cached Avatar as the Watches page,
including retries and pending delivery after a worker restart. Notifications do
not fetch an image. A check refreshes the cache before notifying, so a picture
cached by that check can appear immediately. A Watch without Avatar tracking
keeps the existing weekly refresh limit. No cached picture, or a picture the
browser rejects, uses GramGrab's packaged icon instead.

1. Use an existing enabled Watch with notifications and a cached Avatar. It
   need not track Avatar changes. Read cache presence and notification states
   as booleans only, and preserve the request ledger.
2. Let a natural discovery notify, or open Needs you and click an existing
   notification's Retry button. Accept the optional permission prompt if
   offered. Compare the icon sent to `notifications.create` with the cached
   JPEG in memory, retain an equality boolean, and require browser acceptance.
   A read-only probe must forward calls to the real API. Capture the Avatar
   and notification with the login hidden.
3. For a pending notification, restart the worker and let its normal pump
   resume delivery. Require the same cached icon without an image fetch.
   Missing natural notification states are a prerequisite to report. Seeding
   states for existing discoveries in an isolated profile needs explicit user
   authorization; it does not authorize new media, identity changes or ledger
   resets.
4. Prove the packaged-icon fallback when an actual cached image is absent or
   rejected. Controlled cache states belong only in the isolated profile;
   restore its original cache afterward. Focused tests own cases that cannot
   be reached live, including a newly populated cache in the same check.

Desktop rendering is separate from API acceptance. When desktop screenshots
are unavailable, attach a clearly labeled capture of the icons forwarded to
the real browser API and report the desktop-rendering gap.

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
report `deferredUntil` with no kinds run. Preserve and report that deferral on a shared account.

## Rate-limit pause

Only a 429 on a Watch request pauses Watches. A person's own request that gets a
429 must not, because Instagram routinely answers `web_profile_info` with 429
and the person's flow falls back to `topsearch`. `scripts/throttle.mjs` answers
the worker's matching requests with a status, so both sides are drivable on an
isolated QA account. This synthetic fault-injection recipe is not a live fetch
and must not be run against a shared personal account:

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

## Request cap

The ledger in `instagram-requests` counts every Instagram API attempt, the
person's included, and holds Watch requests once the rolling hour has 60. That
hold is not a pause: it shows as `schedule.cappedUntil` in `watch list --json`,
not `pausedUntil`, and adds no `PauseAttention`. Reaching it with real traffic
costs 60 requests on the real account, so seed the ledger instead, on the
verification profile only. The seed is local timestamps, so say so in evidence;
it is not an Instagram response.

1. Read `instagram-requests`, `watch-scheduler` and the Watch count from the
   worker as counts and booleans. With the browser still inside its two-minute
   startup hold, so no Watch request has started, write `attempts` as 60
   timestamps spread over the last 40 minutes, keep any `pause`, and put one
   Watch ID in the login's `remaining` with `nextRoundAt` hours ahead. Run
   cleanup, then `launch.sh --restart`. The running worker keeps its ledger in
   memory, so a write without a restart is overwritten on its next request.
2. Read `attempts` back: 60. Open `options.html`. The sidebar reads `Waiting: 1
   left this round`, not `Checking`, and a `Watches waiting.` banner says Watch
   checks resume around a time about 20 minutes out. Opening the page verifies
   the viewer as the person, which adds one attempt and can move that time.
   The page follows `instagram-requests` and `watch-scheduler` in storage, so
   an open page picks up a cap that fills later without a reload.
3. Open the Watch and click Check now once. The line reads `Watch requests are
   spaced out. This check can run at HH:MM.` with the floor computed for that check, the
   button returns to `Check now`, and no Watch request starts.
   The click's own viewer requests can push the banner's time later than the check's time.
   Do not click again to make the times agree.
4. To prove an open page clears the banner as the cap ages out, extend the
   verification scheduler's `startupHoldUntil` before its two-minute hold ends.
   Once person requests have finished, seed 60 identical ledger timestamps at
   `Date.now() + 90_000 - 3_600_000` and set `nextWatchAt: 0`. Without reloading
   or starting another request, the banner picks up the new time and disappears
   after about 90 seconds. The sidebar returns to `Checking: 1 left this round`.
5. Run cleanup soon after. Once the seeded attempts age out the round runs for
   real against the account.

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
