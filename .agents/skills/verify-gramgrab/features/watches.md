# Watches

Watches Beta has an options page and a packaged CLI over the same background
handlers. Read `docs/watch-live-verification.md` for the current observed matrix
and account constraints, and `docs/watch-boundary-coverage.md` for the tests that
own simulated failures and interruptions.

On a shared real account, preserve `instagram-requests`, including inherited
pauses and attempt counts, and `instagram-requests.linked` when a second login
is linked. The recipes below run under the main login unless they say otherwise;
[Linked login](#linked-login) covers the other one. Use existing discoveries and the page's storage
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
4. Switch to the Inbox tab and back. The link returns with the selected username's
   profile URL. If another Watch exists, select it and require both the heading
   and destination to follow that Watch. Record a missing second Watch as a
   live prerequisite rather than changing stored usernames to simulate one.

## Sidebar layout

From the top, the sidebar holds the title and the Logins control
(`.opt-logins-summary`), the `Needs you` and `Inbox` tabs side by side
(`.opt-views button`, each with its count; Needs you hides a zero count), the
`WATCHES (N)` heading with a `+ Add` button (`.opt-list-head`), the
`Search Watches` box (`.opt-search`) while any Watch exists, the owner
filter while more than one login owns a Watch, the Watch rows filling the rest
of the height, a one-line footer, and the `Export or import Watches` text link
(`.opt-foot-link`).

The footer's `<summary>` reads `Next check in 41m · 14% storage`, using the
login whose checks run first: a login mid-round reads `Checking, N left this
round` (`Waiting` while a hold applies), else the earliest next round. Unless
a round is running, its `title` holds the absolute time. Opening it shows each
login's line, only while both logins have one, then the `Watch storage` meter,
then the Avatar note when it applies. The relative time re-renders every
minute.

1. Open `options.html`. Read the `.opt-views button` texts and the
   `.opt-list-foot summary` text, then click the summary. Require the meter to
   appear and the summary's percentage to match `usedBytes / budgetBytes`.
2. Screenshot the sidebar closed and open. Blur the login names first.

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

## Watch tabs

An open Watch has two tabs in `.opt-tabs`: `Inbox (N)` first and selected,
then `Found (N)`. Inbox lists collected entries with `Select inbox item`
checkboxes. Found lists every discovery and its action history, without
checkboxes. A notification click opens `options.html#watch=<id>`, which lands
on the same Inbox tab.

1. Open `options.html` and select the `instagram` Watch. Read the `.opt-tabs`
   button texts in order and which has class `active`. Require Inbox first and
   active.
2. Click `Found`. It becomes active and shows no `Select inbox item`
   checkbox. Switch to the sidebar's Inbox tab and back to the Watch: Inbox is active again.
3. In the worker, read the `instagram` Watch's `id` from `watch-store` and open
   `options.html#watch=<id>` in a new tab with `chrome.tabs.create`, so the ID
   stays in memory. Require Inbox active there. `drive.mjs targets` prints that
   tab's URL with the ID, so match it as `options.html#watch` instead. Close it
   from the worker with `chrome.tabs.remove`, since `drive.mjs` has no close.

## Entry links

Each Found and Inbox entry's media label (`Photo`, `Video`, `Carousel of N`,
`New picture`) is an `a.opt-entry-link` that opens Instagram in a new tab. The
page derives the target from the stored username and IDs; nothing stores a URL.
A Post or Carousel opens `/p/<shortcode>/` and a live Story
`/stories/<username>/<id>/`. An expired Story, an Instant and an Avatar open the
profile, since none has a page of its own. All inbox lists the same rows.

This needs at least one natural entry. A Watch has none until a check finds
media published after its baseline, and Check now on a shared account needs a
separately authorized run, so record an empty Watch as a live prerequisite.

1. Open `options.html`, select a Watch with entries, `instagram` when it has
   any, and on each tab read every `a.opt-entry-link`'s text, `href` and
   `target`. Require one link per entry row, `target="_blank"`, and an `href`
   whose shape matches the row's kind in its meta line. Capture the list
   cropped to the entry rows, which keeps the Watch's username out of frame.
2. Click one link. Require a new tab on that `href` and an unchanged options
   page with the same Watch and tab selected. Close only the new tab from the
   worker with `chrome.tabs.remove`. Opening the page is a browser navigation,
   not a GramGrab request, so it does not touch `instagram-requests`.

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
2. Use the shared card's `Select item NN`, `Frame`, `Remove audio`,
   `Rotate item NN` and `Crop item NN` controls. Deselecting every card disables download. Frame and
   Silent are mutually exclusive. Frame download waits for measured metadata;
   its slider and video `currentTime` must agree at a nonzero timestamp. Rotate
   and check the preview's orientation and aspect ratio before download.
   `Crop item NN` opens the same selector as the workspace on the card; a
   later rotate turns `.crop-rect` with its subject. Downloading a cropped
   video that is not a Frame first opens a `Some videos require re-encoding`
   alertdialog reading `Cropping a video re-encodes it.`. `Cancel` starts
   nothing; `Re-encode cropped videos` exports it, and History records `crop`
   and `requestedExport.crop`.
   With Frame on, read each control's `getBoundingClientRect()`. `Frame`,
   `Remove audio` and the rotate button are one height, and every row they
   wrap into starts at the controls' left edge and fills its width. The
   timestamp row spans that width below them, and `Select item NN` stays
   inside the card. The inspector column is a fixed width, so check a wider
   card in the popup workspace, which shares this layout.
3. Download Original, Frame and Silent from the same recorded entry, fetching
   again only when needed. Require completed, nonempty files; check the Frame
   JPEG against its requested timestamp/rotation and the Silent MP4 with
   `ffprobe` for video without audio. Use the actual re-encoding consent dialog
   if offered. Compare delivered identities with the recorded reference in
   memory, saving equality booleans rather than IDs or URLs.
4. Learned unavailable reasons remain on the discovery row when selection
   changes. An available Sidecar child keeps its recorded ordinal when another
   child is missing or deselected. Avatar cards offer Original only, without
   Frame or Silent, but with `Rotate item NN` and `Crop item NN`. Use natural
   entries for these routes; missing Sidecars or expired entries are explicit
   live prerequisites, with adapter boundaries owned by the focused tests.
   Without a natural Avatar change, `scripts/watch-avatar.mjs seed` adds a
   paused fixture Watch whose one Avatar entry records the picture the real
   `instagram` Watch last saw, so it exports; `remove` drops it. Label its
   screenshots synthetic. Rotated once with a `4:5` crop it saves a 864x1080
   JPEG, and `gramgrab history redownload` of that receipt saves the same size.
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

## Inbox filters and Watch search

All inbox has two chip rows, `.opt-chip-filter` groups labelled `Account` and
`Media type`; the picked chip has `aria-pressed="true"`. Account holds
`All accounts`, then `Main` and `Linked` while both logins collected entries,
then one `@username` chip per Watch with entries. Media type holds
`Everything`, `Photos`, `Videos`, `Carousels` and `Stories`, which do not
overlap: Stories are their own type, a new picture counts as a photo. The rows
combine, an empty result reads `Nothing matches these filters.`, and picking a
different chip clears the selection. Each row's `.opt-entry-head` starts with
the account's Avatar. The sidebar's `Search Watches` box narrows the rows and
the `WATCHES (N)` count by username as you type, ignoring case and a leading
`@`, and reads `No Watch matches` when empty. Neither is stored, so a reload
resets both.

A shared account usually has one Watch, so seed a second account first:
`node .agents/skills/verify-gramgrab/scripts/watch-filters.mjs seed` adds a
paused `creators` Watch with one Photo and one Carousel of 2. It is never
checked. Run `watch-filters.mjs remove` in a `finally` step, and label its
screenshots synthetic. Do not click its entry links; their shortcodes are fake.

1. Open `options.html` and the sidebar's Inbox tab. Read each group's chip
   texts and every `.opt-feed .opt-entry-head` text and Avatar element.
2. Click `Select all`, then a Media type chip. Require zero ticked checkboxes.
   Walk `Videos`, `Stories`, then `@creators` with `Stories` for the empty
   message, then `Carousels` and `Photos`. Require each result to match the
   seeded and natural entries' kinds.
3. Type `@CREATORS` into `.opt-search`: one `@creators` row and `WATCHES (1)`.
   Replace it with `nobody`: `No Watch matches` and `WATCHES (0)`.
4. Reload. Require `All accounts`, `Everything` and an empty search box, and no
   new key in `chrome.storage.local` or the page's `localStorage`.

The `Main` and `Linked` chips need a linked second login with collected
entries. Without one, record it as a live prerequisite;
`watches.test.tsx` owns it.

## Long Watch list

The options page is three fixed-height panes. The Watch list, the feed and the
inspector each scroll on their own, and the document itself never scrolls. The
header with the Logins control, the Needs you and Inbox tabs, the Watches label
with `+ Add`, the footer line and `Export or import Watches` stay in place
however long the list is. Below about 500px of height, or with the Logins
control or footer open on a short window, the list keeps a 120px floor and the
whole sidebar scrolls instead.

1. A long list needs more Watches than a shared account should check. Seed
   paused local fixtures on the verification profile only:
   `node .agents/skills/verify-gramgrab/scripts/watch-fixtures.mjs seed 12`.
   They copy the first Watch's viewer, are disabled, and are never checked.
   Run `watch-fixtures.mjs remove` in a `finally` step. It deletes only Watches
   whose target ID has the fixture prefix, so it works after a relaunch.
2. Open `options.html`, select a Watch, and wheel over `.opt-watch-list` with
   CDP `Input.dispatchMouseEvent`. Require `document.scrollingElement.scrollTop`
   to stay `0` with `scrollHeight === innerHeight`, `.opt-watch-list` to scroll,
   and `.opt-head`, `.opt-list-head` and `.opt-foot-link` to keep their positions.
3. Click `+ Add` while the list is scrolled. The `Add Watch` heading, the
   account input and `Find account` must sit inside the viewport with no scroll.
4. Select a fixture Watch, which has 40 discoveries, and wheel over
   `.opt-feed`. The feed scrolls and the sidebar does not move.

Use the window's own viewport. In this environment
`Emulation.setDeviceMetricsOverride` makes wheel events hang, and so does a
window shorter than about 500px, so read short-height layout from element
metrics rather than wheel input. A `hidden` page also hangs input and
screenshots. Run `drive.mjs activate options.html` first.

## Long usernames

A username that is wider than its container must never escape it. Routes
(materials differ, mechanism differs): a sidebar Watch row's `.opt-clamp`
wraps mid-token to at most two lines and puts the full handle in `title`; the
closed Logins control's `.opt-name` (full handle in `title`, or `Signed out`
for an ended linked login) and an open Watch's chip truncate with an
ellipsis; status surfaces (`.opt-grow`, `.opt-add strong`, `.opt-banner`)
wrap with `overflow-wrap: anywhere`. The login-tab route lives in
[Linked login](#linked-login): without a linked login, drive its rule through a
synthetic styled duplicate in the page, labeled as such, and record the live
gap.

1. On `options.html`, seed a paused long-handle Watch (fixture script target
   ID only, the same way as Long Watch list). Measure the row name with
   `getBoundingClientRect()` and `scrollWidth`/`clientWidth` whenever the
   element hides its overflow. The row name must hold `-webkit-line-clamp: 2`
   with `scrollWidth === clientWidth`, a height of at most two line heights,
   and the full handle in `title`. Record the widths and the height.
2. Select the long Watch. The chip's name element truncates the same way and
   its `title` carries the full handle; the chip stays inside the viewer
   header.
3. Below 900px of width: the `@<handle>` headline must not paint over the
   `Check now` button: the headline's right edge stays left of the button's
   left edge, evaluated on element rects wherever input is wedged. The feed
   column must not widen by blocked content: `.opt-feed` has
   `scrollWidth === clientWidth`.
4. Status surfaces never widen their boxes: on a long needs-you copy,
   `scrollWidth === clientWidth` on every box, and wrapped lines stay inside
   their column. Verify the same on `.opt-add strong` for a feed empty state
   or a copy the fixture seed produces.
5. `watch-fixtures.mjs remove` in a finally step, as with Long Watch list.

## Export and import

`Export or import Watches` at the bottom of the sidebar saves the verified login's Watches to a file
and adds the Watches in such a file. The file holds each account ID and
username, its kinds and actions, and whether it is paused. It holds no login,
baseline, discovery or Avatar image. `docs/adr/0006` records why. There is no
CLI verb.

Import spends at most one viewer request and one profile request per account it adds.
An account already watched costs none, so steps 1 to 3 are safe on a shared
account. Step 4 adds a Watch and needs the same authorization as Check now.

1. Open `options.html` and click the `Export or import Watches` sidebar link. The feed
   shows `Export and import` with an `Export N Watches` button, where N is the
   sidebar count. Click it. A `gramgrab-watches-YYYY-MM-DD.json` file lands in
   `$GRAMGRAB_VERIFY_DOWNLOADS` with no Save As dialog. Require
   `format: "gramgrab-watches"`, `version: 1`, one entry per sidebar Watch, and
   exactly the keys `accountId`, `username`, `enabled`, `kinds`, `actions` on
   each entry.
2. Choose that file: `node $D upload options.html 'input[aria-label="Watches
   file"]' FILE`. Every account is listed under `Already watched, skipped (N)`
   with its account ID, kinds and actions, the page says `Nothing to add`, and
   no Import button or disclosure appears. `watch-store` is unchanged.
3. Copy the file, change `version` to `2`, and choose the copy. The page says
   `This is not a Watches file this version of GramGrab can read. Nothing was
   imported.` and shows no preview. Repeat with an extra key on one entry.
4. With authorization, write a file with one account the login does not watch,
   `enabled: false` so nothing checks it, and a deliberately wrong `username`.
   Choose it. `Will be added (1)` lists it as `Paused` under the file's
   username, and `Import 1 Watch` stays disabled until the disclosure is
   ticked. Read `watch-store` before importing: it has not changed. Tick the
   disclosure and import. The page says `Added 1 Watch.`, the file input
   empties, and the sidebar gains a `Paused` Watch under the username Instagram
   returned, not the file's. In `watch-store` it has `tracking: {}` and
   `discoveries: []`. Delete it through its confirmation UI afterward.
5. Choose a second file while a preview with a ticked disclosure is showing.
   The new preview's disclosure must start unticked.

Focused tests own an account Instagram does not confirm and an import a failed
request stops early. Do not induce either on a real account.

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
2. Switch to the Inbox tab and back, then reload `options.html`. Both times the
   button still reads `Checking…` (or `Waiting…` while held) with the same or
   later progress. A second
   click is impossible while it is disabled. `watch check instagram --json`
   during the check returns `deferredReason: "queued"` and the `manual` array
   in `watch-scheduler` still holds one job for the Watch.
3. Stay on the Inbox tab until storage reports `ManualCheckFinished`, using the
   live page or a bounded worker-storage wait. CLI Watch reads verify the viewer
   and can consume requests, so they are not a polling mechanism. A check took 2 to 11
   minutes in live runs, longer while an unattended round shares the queue.
   Return to the Watch: the button reads `Check now` and the line reads
   `Last check ...:` with one outcome per kind. It survives a reload.
4. Click Check now again within five minutes. It returns at once with `Checked
   in the last 5 minutes. Check again at HH:MM.` With a rate-limit pause active
   it says `Instagram rate limited a Watch request. Checks wait until HH:MM.`
   instead, and other spacing, the hourly cap included, reads `Watch requests
   are spaced out.`

## Check now placement

Check now sits at the right end of the Watch header row, top-aligned. Its
progress, result and failure lines stack right-aligned under it, at most half
the row wide, so the button keeps its place whatever the line says.

1. Reach a line under the button without a new Watch request: an inherited held
   manual check (`Waiting…` with `Still to check:`), a `Last check` line, or
   the single click in Request cap. Do not click Check now only to make a line.
2. Read the rects of `.opt-check-now > button` and its header row, the
   `.opt-check-now` parent. Require `rowRight - buttonRight` under 1px, the
   button's top equal to the row's top, and the column on the same line as the
   `@username` heading rather than wrapped below it. Read the same values
   before the line appears when the recipe passes through that state.
3. Crop the header row plus a small margin, with the verified login out of
   frame.

## Setting save status

Each Watch setting in the inspector saves on click: a kind, an action, or
`Pause checks` / `Resume checks`. The changed row shows `Saving` with a
spinner (`.opt-save`, `role="status"`) and every setting control is disabled
until the save settles. The checkbox shows its new value meanwhile. Success
reads `✓ Saved` for about 2 seconds. A failure puts the checkbox or button
back, and shows the error under that row (`.opt-save-failed`, `role="alert"`)
with `Try again`. Setting failures never use the middle column's action banner
(`.opt-feed > p.opt-banner-error`). A failed store write still raises the
separate `Watches stopped.` storage notice there. Each save verifies the
login once, which costs a viewer request only when the last read is more than
5 minutes old.

A real save settles too fast to capture, and a real failure needs a broken
store. Slow or fail only the `watch-store` write from the worker. This is
in-memory and ends when the worker restarts. It hooks the promise form of
`storage.local.set`, which the worker uses only when the browser has a native
`browser` namespace. Require `typeof browser` to read `object` in the worker
first (Chrome for Testing 156 does). Otherwise the worker's callback shim
writes, and the hook leaves the save on `Saving`:

```bash
node $D eval "js/background.js" "(() => { const l = chrome.storage.local; l.__set ??= l.set.bind(l);
  globalThis.__fault = { delay: 0, fail: false };
  l.set = (items, cb) => !('watch-store' in items) ? l.__set(items, cb) : new Promise((ok, no) =>
    setTimeout(() => __fault.fail ? no(new Error('injected')) : l.__set(items).then(ok, no), __fault.delay));
  return 'installed'; })()"
node $D eval "js/background.js" "globalThis.__fault = { delay: 1500, fail: false }; 1"
```

1. Open `options.html` and select the `instagram` Watch. Prefer `Notify me`
   or `Download automatically` over a kind: turning a kind back on starts a
   fresh baseline. Install the hook with a 1500ms delay and click the
   checkbox. Within the delay, require the new `checked` value, `disabled` on
   every inspector input and on the checks button, and `Saving` in the row's
   `role="status"`. After it, require `✓ Saved`, the action in `watch-store`,
   and no status 2 seconds later. Capture the inspector at both points.
2. Set `fail: true` and toggle the same row back. Require the old `checked`
   value, the error and `Try again` under that row, and no
   `.opt-feed > p.opt-banner-error`. Set `fail: false`, click `Try again`, and
   require `✓ Saved` with `watch-store` changed. This also restores the
   setting.
3. Repeat on `Pause checks`: `Saving` sits beside the button and success
   relabels it `Resume checks`. Fail the resume to see the error under the
   button. Do not let a resume succeed only to restore state, since resuming
   starts a catch-up check. Pause and resume on a copied profile change only
   that copy.
4. Reset with `globalThis.__fault = { delay: 0, fail: false }`.

## Live page

An open options page reloads its list, the open Watch and the inbox whenever the
worker writes `watch-store` or `watch-scheduler` in `chrome.storage.local`, or
changes the rate-limit pause in `instagram-requests`. Those reloads go through the
`WATCH_READ` message, once per signed-in login. The worker answers without an
Instagram request while that login is still the last one any viewer read found,
and verifies again otherwise. Opening the page first lists the Watches of the
logins `watch-viewer` and `watch-viewer.linked` name, then verifies. Returning to
its tab or window and every action verify the login once. A verification the
person starts reuses the worker's last viewer read from the past 5 minutes while
the login's `sessionid` cookie is unchanged, so it costs a request only after
that. The reuse lives in worker memory, so a worker restart drops it and the
next check reads again. Unattended Watch work always reads again. Tab visibility and window focus events
for one return share a verification. Storage reloads wait for that verification,
and changing the login clears the previous login's selected view and inbox
selections. A signed-out page rechecks on return too. There is no login polling.
The page also follows the `watch-viewer` and `watch-viewer.linked` keys in
`chrome.storage.session`, which every viewer read writes, including the CLI's.
When `watch-viewer` is removed, the page drops to the sign-in gate without a
request. When either key names another login, or `watch-viewer.linked` is
removed, the page verifies once. A Watch the previous login owned stays in the
list, held and paused. Chromium fires no change event when a query rewrites the
same login.

1. Read `nextRoundAt`, `remaining`, each kind's `lastCheckAt`, and the length of
   `attempts` in `instagram-requests` from the worker's storage. Open
   `options.html`, leave it on the Inbox tab and screenshot it.
2. Let a round run while the page stays open. A launch on an overdue profile
   starts one after the two-minute startup hold. Otherwise make the deadline
   overdue as in `docs/watch-live-verification.md` step 5: set `nextRoundAt` to
   a past time from the worker. The pump alarm runs every minute. Poll storage
   from the worker, not the CLI, so waiting costs no request.
3. While the round runs, the footer summary starts `Checking, N left this round`,
   and the row's `Checked` time moves without a reload. When `remaining` is
   empty, it starts `Next check in` the time until the new `nextRoundAt`, and its
   `title` is that time. Screenshot both.
4. Compare `attempts` with the Watch requests the round made. The page adds
   none. Pause and then resume the Watch from the page: each action adds at most
   one viewer request, none within 5 minutes of the last viewer read, and the
   reload after it adds none.
5. After the initial load settles, set an in-memory page marker and record the
   request count. Activate a neutral tab, then return to `options.html` without
   reloading. The return confirms the login, with one viewer request only when
   the last viewer read is more than 5 minutes old; the marker survives.
   Keep the page foregrounded briefly and confirm it adds no further requests.
   Repeat once by moving focus to another browser window and returning, to
   cover the window-focus path. Stop on a 429 or request-cap deferral.
   Follow `docs/watch-live-verification.md` for account changes: use a natural
   switch or sign-out if one occurs, otherwise report that live gap. Focused
   browser-adapter tests own switched-login isolation and sign-out recovery;
   an unchanged real login proves foreground verification, not account switching.
6. Open a second `options.html` while `watch-viewer` names the login. The
   console (`.opt-console`) appears without waiting for Instagram, in well under
   a second by `performance.now()`, then the background verification settles
   without changing it. A browser session with no `watch-viewer` yet shows
   `Loading Watches…` until its first verification answers.
7. With a page marker set, record the request count and run
   `gramgrab watch list` once. The count grows by at most the CLI's one viewer
   request, none within 5 minutes of the last read, and the page keeps its
   marker and console. To drive the page's login-loss
   path without signing out, run
   `chrome.storage.session.remove('watch-viewer')` from the worker, which is
   what a viewer read that finds no login does. The page shows `Sign in to
   Instagram` with the stored count, keeps its marker, and adds no request.
   Return to the tab: the console comes back. It costs no request while the
   worker's last viewer read is under 5 minutes old, since that reuse does not
   read `watch-viewer`. That reuse does not write `watch-viewer` back either, so
   it stays absent until the next fresh viewer read. This injects session state
   only. A real sign-out stays a reported live gap.

## Avatars

The options page shows an Avatar for the main login in the Logins control at
the top of the sidebar, beside each Watch in the sidebar list, and beside the username in an
open Watch's header. Each one is an `img.opt-avatar`, or a `span.opt-avatar`
holding the username's first letter while no picture exists.

Initials have a muted fill and a thin dashed ring. Watch initials carry the
tooltip and accessible image label `Initials stand in for pictures. Pictures
update during Watch checks.` The login's hint is only `Initials stand in for
pictures.` The linked login always shows its initial, since only the main
login's picture is held. The opened sidebar footer shows the full Watch
explanation once the initial
cache read has finished and any Watch lacks a cached picture. It disappears
when every Watch has a cached picture; an empty Watch list shows no note.
Opening the page does not start an Avatar lookup.

- A Watch's picture identity is the asset name in its picture URL, read from the
  ID-keyed profile. Watch store version 1 held topsearch picture IDs; reading it
  drops those baselines and cached pictures, so the next check records a fresh
  baseline instead of a change.
- A Watch's picture is cached on its Watch record as `avatarImage` (`pictureId`,
  base64 `jpeg`, `checkedAt`). The JPEG is 80 by 80 pixels, capped at 8 KiB
  decoded bytes. It is written after a check, never on page open. A
  Watch of Avatar changes reuses the identity its check read and loads the image
  only when that identity changes. Any other Watch spends at most one ID-keyed
  profile request a week, including failed attempts, tracked by `avatarLookupAt`. An
  initial image can use this lookup after a partial check that omitted Avatar.
  A failed Avatar step does not repeat the same lookup. Request-cap deferrals
  leave the timestamp unchanged. The timestamp must fit before a request starts.
  An optional image that exceeds the 2 MiB store budget is skipped without a
  storage warning. A check that loses login verification does not refresh images.
  Ownership is checked after request spacing. An unspent lookup cancelled by a
  login change leaves the cooldown unchanged.
- The login's picture comes from successful viewer reads, is held in worker
  memory, and is never stored. Opening the page costs no extra Instagram request
  for it. The open page keeps its login image across empty cache reads after a
  worker restart, until a viewer read repopulates worker memory.

1. Read the store from the worker as booleans only: whether each Watch has
   `avatarImage` and the `jpeg` length. Never print the base64 or the IDs.
2. Open `options.html`. With no `avatarImage` yet, the row and header show the
   initial. Open the Watch by its sidebar button and confirm its account and
   status remain the button's accessible name. The row and header initials
   have the full Watch hint in `title` and `aria-label`, and their computed
   `border-style` is `dashed`. Opening the footer shows the explanation once,
   below the storage meter. It is muted, rather than a warning. A pending initial cache
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
   and after. The reload adds nothing for Avatars, and at most one attempt for
   the viewer read, none within 5 minutes of the last one unless the worker
   restarted since.
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
   `WATCH_CHECK_INCOMPLETE`. A failure names its rule in the kind's `reason` in `watch show --json`:
   `foreign-owner` for collab ownership, `inconsistent-page` or `repeated-traversal` for grid order.
3. Screenshot the Watch on the options page, then `watch delete TARGET`. Redact the target and
   the login before a screenshot leaves `.local/`.

A copied profile can carry a rate-limit `pause` in `instagram-requests`, which makes every check
report `deferredUntil` with no kinds run. Preserve and report that deferral on a shared account.

## Fetched media is seen

Media the person fetches in the popup, workspace or CLI is marked seen for the verified login's
Watches of its author or co-authors, whether or not it is downloaded. The record is
`tracking.<kind>.seen`, a list of media IDs with publication times, and the next check of that kind
skips them. Only media newer than the kind's baseline and inside 30 days is recorded, so the
official `instagram` Watch, whose recent media is usually already found, rarely shows a change.
This recipe uses a paused fixture Watch of the same account with older baselines instead. It
spends the ordinary fetch requests plus at most one viewer request every 5 minutes, and no Watch
check.

1. Launch, then within the two-minute startup hold run `watch-problem.mjs hold 60` and require
   `"held":true`. The seed copies the official `instagram` Watch's IDs, so a profile without one
   needs it added first, through Add Watch on the options page or `gramgrab watch add instagram
   --kinds posts,stories --actions collect --accept-unattended`. The hold keeps its first check
   from running.
2. `node .agents/skills/verify-gramgrab/scripts/watch-seen.mjs seed 7`, then `watch-seen.mjs read`:
   `present: true` with `postsSeen: 0` and `storiesSeen: 0`.
3. In the workspace, type `https://www.instagram.com/stories/instagram/` into `#source-url` and click
   `.fetch-row button`. When the media shows, `watch-seen.mjs read` reports `storiesSeen` equal to
   the number of Stories shown, unless the account has none active.
4. Fetch one `instagram` Post from the last seven days the same way. Find one by reading `/p/` and
   `/reel/` links off `https://www.instagram.com/instagram/` in the driven browser. `postsSeen`
   becomes 1, and a Sidecar still counts once.
5. `gramgrab inspect` of the same Post leaves the counts unchanged, since the media is already seen.
6. `watch-seen.mjs remove` in a `finally` step. It removes only the fixture, by its fixed ID.

That the next check skips the media is owned by the "Media the person fetched" tests in
`watch/check.test.ts`. Proving it live needs a Watch check, so it needs the same authorization as
Check now.

## Check problem

A kind whose check failed shows its problem in the Watch's health row and in Needs you. The stored
record is `tracking.<kind>.problem` with a `code`, a time, and for `WATCH_CHECK_INCOMPLETE` a
`reason` naming the rule the answer broke. Only an answer that does not decode is
`IG_RESPONSE_SHAPE_UNKNOWN`, which reads `Instagram's format has changed`. A body that is not JSON,
a GraphQL `errors` answer, another account's Post, a future publication time and an inexact
identity or Sidecar are `WATCH_CHECK_INCOMPLETE`, which reads `Check stopped before it finished`.
Both codes offer `Preview diagnostics` in the health row, then `Copy diagnostics`.

Instagram does not produce these answers on request, and answering for Instagram is fault
injection. So this recipe seeds the stored record on the official `instagram` Watch and proves what
the page does with it. Say in evidence that the record is a seeded local state. The readers that
produce each code and reason belong to `watch/check.test.ts`.

1. Launch, then within the two-minute startup hold run
   `node .agents/skills/verify-gramgrab/scripts/watch-problem.mjs hold 60`. It must print
   `"held":true`. No Watch work starts while the hold lasts, so the seeded record is not checked
   away and no round spends requests.
2. `watch-problem.mjs seed WATCH_CHECK_INCOMPLETE not-json`, open `options.html` and select the
   `instagram` Watch. `.opt-health-row.opt-health-problem` reads `Check stopped before it finished`
   and never `format has changed`. Click its `Preview diagnostics` button. The
   `pre.diagnostics-preview` JSON has `code`, `phase: "resolving"`, `scope: "batch"`,
   `mediaKind: "posts"` and `reason: "not-json"`, and no other failure field. Parse it and check its
   key set rather than reading it by eye.
3. `watch-problem.mjs seed IG_RESPONSE_SHAPE_UNKNOWN`. The open page follows the store, so the row
   changes to `Instagram's format has changed` without a reload, and its preview has no `reason`.
4. Needs you lists `@instagram · Posts` with the same copy as the health row.
5. `watch-problem.mjs remove` in a `finally` step. It removes only a record it seeded, which it
   knows by a fixed timestamp, and refuses to seed over a real problem.
6. To prove a successful check clears a problem, seed one, then run `watch-problem.mjs quiet` and
   `release`, and click Check now once. `quiet` moves the round and early retries six hours ahead so
   only that check runs. When storage reports `ManualCheckFinished`, the Posts outcome is
   `KindCheckSucceeded` and the row reads `Checked just now`. This spends one real check of the
   official account, so it needs the same authorization as Check now, and a seeded problem's time
   is not a real one. Run cleanup right after. A copied profile can already hold a queued manual
   check: the button reads `Checking…` and `watch-scheduler` has a `manual` job. Reuse it instead
   of clicking. After `quiet` and `release` it resumes on the next pump alarm, within a minute or
   two, and checks only its remaining kinds.

Crop screenshots to the row: `drive.mjs shot options.html FILE ".opt-health-row.opt-health-problem"`
keeps the sidebar and its usernames out of the file.

## Problem after an update

When GramGrab updates, `runtime.onInstalled` with reason `update` books an early retry due at once for
every enabled Watch kind whose problem is `IG_RESPONSE_SHAPE_UNKNOWN` or `WATCH_CHECK_INCOMPLETE`.
The retry runs after the worker's fresh two-minute startup hold, and a successful check clears the
problem. Other problem codes keep their normal schedule.

1. Launch, then within the startup hold run `watch-problem.mjs hold 60`,
   `seed IG_RESPONSE_SHAPE_UNKNOWN` and `quiet`. Count the enabled kinds that already hold a real
   problem with either code: each one also gets a retry, which spends a real check.
2. Reload the unpacked extension the way the Reload button on `chrome://extensions` does: open that
   page and eval `chrome.developerPrivate.reload(EXT_ID, {failQuietly: true})` there. Chromium
   reports this as `update`. The extension can come back `DISABLED`; re-enable it from the same page
   with `chrome.management.setEnabled(EXT_ID, true)` and run doctor before driving on. Never use
   `chrome.runtime.reload()`.
3. Read `watch-scheduler` at once. `earlyRetries` holds the Posts retry of the `instagram` Watch,
   while the round stays six hours out. Without the update path it holds none. The worker that
   booked it also set the fresh startup hold, so `startupHoldUntil - at` is 120 seconds. Judge
   timing by that, not by the reload time: a reload that came back `DISABLED` books the retry only
   when the re-enabled worker starts, minutes later.
4. About four minutes later the retry has run one real Posts check. The stored Posts problem is gone
   and `earlyRetries` is empty. The reload closed every extension page, so open `options.html` again
   and select the Watch: the Posts health row reads `Checked ... ago` with no format change. Run `watch-problem.mjs remove` in a `finally` step;
   it finds nothing to remove once the check cleared the seeded problem.

## Rate-limit pause

Only a 429 on a Watch request pauses Watches. A person's own request that gets a
429 must not, because a person's request can hit an endpoint that answers 429 on
its own, such as the Highlights tray. `scripts/throttle.mjs` answers
the worker's matching requests with a status, so both sides are drivable on an
isolated QA account. This synthetic fault-injection recipe is not a live fetch
and must not be run against a shared personal account:

1. Read `instagram-requests` from the worker's `chrome.storage.local`. An
   inherited `pause` comes from earlier runs, so clear the key and relaunch
   before judging, and only on the verification profile.
2. Start `node .agents/skills/verify-gramgrab/scripts/throttle.mjs
   highlights_tray 429` in the background and keep its output.
3. Run `gramgrab inspect https://www.instagram.com/instagram/ --json`. The
   throttle log shows a 429 for `highlights_tray`, the inspect still exits 0
   with the Avatar, and
   `watch list --json` has no `schedule.pausedUntil`. `watch needs` has no
   `PauseAttention`, and the options page shows no `Watches paused` banner.
4. Stop the throttle. A manual check verifies the viewer once as the person and
   then again as Watch work. The Watch work always reads the instagram.com home
   page (`fetchViewer` in `apps/extension/src/watch/identity.ts`). The person's
   check reuses a read from the last 5 minutes (`recentViewer`), so run `watch
   list --json` first to make one. Within 5 minutes, start
   `throttle.mjs https://www.instagram.com/ 429 --exact` and run `watch check
   instagram --json`, then stop the throttle at once, since the Watch work's read
   drops the reuse and the next `watch list` or `watch needs` reads the home page
   again. The log shows one 429 and no `passed` line. The Watch request's 429
   sets `schedule.pausedUntil` about 30 minutes out, `watch needs` has a `PauseAttention` with `IG_RATE_LIMITED`, and the options page
   shows `Instagram rate limited a Watch request`. When the person's read is
   older than 5 minutes, or the worker restarted between the two commands, the
   person's viewer check takes the 429 instead, so the check fails with
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
   the viewer as the person, which adds at most one attempt and can move that time.
   The page follows `instagram-requests` and `watch-scheduler` in storage, so
   an open page picks up a cap that fills later without a reload.
3. If the Watch already holds a manual check, the button stays disabled and
   reads `Checking…`, or `Waiting…` once the check itself records a deferral
   time. Record that state and do not wait it out. Otherwise open the Watch and click Check now once. The line reads
   `Watch requests are spaced out. This check can run at HH:MM.` with the floor
   computed for that check, the button returns to `Check now`, and no Watch
   request starts.
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

Watch checks pace requests and can take minutes. Keep `watch check` attached
until it returns: a CLI killed mid-check cancels the check, so the Avatar image
cache that runs after it never does. Rerunning inside five minutes
may defer a check; keep that terminal result as evidence. All-digit WATCH values
mean account IDs unless `--username` forces a username. CLI help is the grammar
reference, including explicit Silent re-encode approval.

## Linked login

With a second login linked ([Linked login](./linked-login.md)), `options.html`
lists both logins' Watches in one sidebar. While the list holds more than one
owner, each row, All inbox entry and Needs you item carries a `.opt-owner` tag
(`Main`, `Linked` or `Other login`), and a filter (`.opt-filter button`,
`aria-pressed`) narrows the rows: `All`, plus `Main` and `Linked` for each login
that owns a listed Watch. Each Watch belongs to
the login that added it. The page sends every command for a Watch as its owner,
so a linked Watch's checks, actions, notifications, and Avatar lookups all run
as the linked login and spend only `instagram-requests.linked`. Add Watch and
Export or import show the `#instagram-login` picker, default `main`, and add to
the login it names.

Watches no signed-in login checks are held: greyed out, with no settings, and
the row reads `Paused · link this login again to resume` for an ended linked
login's Watch or `Paused · sign in as that login to resume` for another login's.

1. Read both ledgers and `watch-scheduler` as counts and booleans.
2. Open `options.html`, click `+ Add`, set `#instagram-login` to `linked`
   the way [Linked login](./linked-login.md) sets the popup picker, and add the
   linked-only account. Its preview shows the account, which the main login
   cannot see.
3. Click Check now once and follow [Check now](#check-now). Require the check
   to finish with an outcome per kind, `instagram-requests.linked` to gain
   attempts, and `instagram-requests` to gain none from the check itself.
4. The new row carries `Linked`, and the `Main` filter hides it.
5. `gramgrab watch list --login linked --json` lists it, and `gramgrab watch
   list --json` does not.

An ended linked session greys the linked Avatar in the closed Logins control,
adds a red dot, and reads `+ signed out`. Opened, the control shows
`Signed out` for the linked login, a `Your linked login was signed out.`
banner, `Link this login again` and `Unlink`. The page lists its Watches as
held rows, and `watch needs` has one
`IG_LINKED_LOGIN_ENDED` item. A held row needs no second
account: seed a `linked-instagram-login` record with `ended: true` and a fixture
account ID, plus fixture Watches whose `viewerId` is that ID or another unknown
ID, from the worker. Restore both keys afterward. Forcing a real ended session
means logging the second account out, so leave it to the synthetic tests in
`linked-login.test.ts` unless the person asks for it.

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
