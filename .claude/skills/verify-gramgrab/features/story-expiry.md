# Story expiry

Story results show `Expires in 3h`, minutes below an hour, `Expires in <1m`
in the final minute, and `Expired` after the deadline. Labels refresh once a
minute while the results stay open. `gramgrab inspect --json` includes
`expiresAt` as an ISO 8601 UTC string when Instagram supplies
`expiring_at_timestamp`. An unknown timestamp produces no field or label.
Highlights, Posts, Avatars, Instants and WhatsApp Statuses have no Story expiry.
Watches shows the recorded Story deadline in Found, each Watch's Inbox and All
inbox before fetching. Fetched preview cards show the deadline from the fresh
Story response through the same label component.

## Drive real results

Use a signed-in verification profile and an account with active Stories.
The official `instagram` account may have none. Set `GG_STORY_URL` to a
consented Story source; keep private handles, media and signed URLs local.
Run doctor before driving and after any unexpected result.

```bash
. ./.local/verify/session.env
D=.agents/skills/verify-gramgrab/scripts/drive.mjs
EV=.local/verify-evidence/story-expiry
mkdir -p "$EV"
node $D open "chrome-extension://$GRAMGRAB_EXT_ID/popup.html"
node $D type popup.html '#source-url' "$GG_STORY_URL"
node $D click popup.html '.fetch-row button'
node $D wait popup.html 'FOUND' 15000
node $D eval popup.html "[...document.querySelectorAll('time.item-expiry')].map(el=>({label:el.textContent,expiresAt:el.dateTime}))"
node apps/cli/bin/gramgrab.mjs inspect "$GG_STORY_URL" --json > "$EV/story-inspect.json"
```

Every known Story expiry must end in `Z` and agree with its card's
`time.item-expiry[datetime]`. Click `Open in tab`, then inspect the workspace's
labels to prove the transfer preserves expiry. Fetch the same source directly
in the workspace too. Reloading a workspace preserves its source, then requires
another fetch to restore results. Require the new results to show the same
known deadlines. If an older transfer supplies Story results without expiry,
those cards must show no label.

## Exercise the clock

Prefer a Story near its natural expiry. For a bounded run, offset only the
page's clock using the first real card's deadline. Instagram responses and
stored timestamps stay unchanged. Label this evidence as a controlled clock.
Run the following with `SURFACE=popup.html` and `PROOF=popup`, then repeat with
`SURFACE='popup.html?surface'` and `PROOF=workspace`:

```bash
node $D eval "$SURFACE" "(() => { const actualNow = Date.now; const offset = Date.parse(document.querySelector('time.item-expiry').dateTime) - actualNow() - 90000; globalThis.restoreStoryClock = () => { Date.now = actualNow; }; Date.now = () => actualNow() + offset; return 'page clock offset'; })()"
node $D wait "$SURFACE" 'Expires in <1m' 70000
node $D shot "$SURFACE" "$EV/$PROOF-final-minute.png"
node $D wait "$SURFACE" 'Expired' 70000
node $D shot "$SURFACE" "$EV/$PROOF-expired.png"
node $D eval "$SURFACE" "restoreStoryClock(), 'page clock restored'"
```

Keep each page foregrounded while waiting. The existing minute timer must
update the label without fetching again or reloading. Restore the clock before
continuing. Reloading clears the results, so fetch again to restore the current
label. For workspace screenshots, scroll an `.item-info` into view so tall
previews do not hide it.
Redact media, filenames and the source field before attaching evidence to a PR.

## Watches

Use a naturally recorded Story discovery. A signed-in profile with active
Stories but no Story discoveries cannot establish this path. Preserve the
request ledger and follow [Watches](./watches.md) for account constraints.

Open `options.html`, then All inbox. Story rows must show their expiry before
`Fetch media`. Open the owning Watch and check the same entry in Found and
Inbox. Select it, click `Fetch media`, and require its preview card's
`time.item-expiry[datetime]` to agree with the recorded deadline. Compare in
memory and retain equality booleans, without saving account or media IDs.

Repeat the controlled-clock recipe on `SURFACE=options.html` with
`PROOF=watches`. Both the selected row and its preview must refresh and reach
`Expired` without another fetch. Restore the clock afterward. Hide the verified
login, Watch account labels, filenames and media before screenshots.

Other Watch kinds have no Story expiry. If there is no natural Story discovery,
record that missing prerequisite. Do not insert fake discoveries or force a
check to turn a baseline Story into a discovery. The Watches integration test
owns the stored reference, summary and fetched-preview boundary.

Fetch a non-Story source and require no `time.item-expiry` or CLI `expiresAt`.
Current Stories may all have timestamps, and a live Highlight or Instant may
be unavailable. Record those prerequisites; focused tests own missing API
timestamps, the UTC conversion and the shared Story/Highlight decoder boundary.
