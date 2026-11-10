# Download history

A record of what GramGrab already saved, so a person can see what they have and
fetch something again without hunting for the URL.

## Sub-features

- List, with a per-item downloaded-at timestamp and an `Open source` link back
  to Instagram.
- Re-download a single entry.
- Remove one entry, or clear everything.
- Repair: a corrupt store is rebuilt rather than thrown away, reported as
  `repaired: true` on a list. An entry the protocol cannot carry, such as an
  empty `filenameHint`, a negative `downloadedAt`, or an unknown `origin.kind`,
  is dropped on its own, from both surfaces, and the rest still lists.
- Downloaded marker: every fetched or inspected item carries `history` with
  `downloaded`, `count`, and `latestDownloadedAt` from matching entries. A
  download recorded at time `0` still reports `latestDownloadedAt: 0`.
- Avatar receipts name the picture they saved. Re-downloading one after the
  account changed its Avatar fails with `WATCH_AVATAR_CHANGED` instead of saving
  the newer picture. Older receipts saved as `profile-avatar:<username>` name no
  picture and always fail that way.
- WhatsApp receipts, which are deliberately weaker: a receipt has no display
  name and no re-download affordance. Only removal applies.

## How to get to it (user POV)

Click `History` in the popup or workspace header. The button toggles to
`Results` while history is showing. `gramgrab history list` prints the same
store.

## Driving it with the harness

```bash
cd "$(git rev-parse --show-toplevel)" && . ./.local/verify/session.env
D=.agents/skills/verify-gramgrab/scripts/drive.mjs

node apps/cli/bin/gramgrab.mjs history list
node $D open "chrome-extension://$GRAMGRAB_EXT_ID/popup.html?surface=workspace"
node $D eval "popup.html?surface" \
  "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='History').click(), 'toggled'"
node $D wait "popup.html?surface" "RESULTS"
node $D shot "popup.html?surface" "$EV/history.png"
```

Save the JSON list before mutation. Use one entry ID to prove re-download on
each surface:

```bash
node apps/cli/bin/gramgrab.mjs history list --json > "$EV/history-before.json"
node apps/cli/bin/gramgrab.mjs history redownload ENTRY_ID --json
node $D click "popup.html?surface" ".history-redownload"
```

Both actions must start a new browser download. Reopen the history list and
confirm the matching entry's downloaded timestamp or count changed. Click its
`Open source` link and require the canonical Instagram source in the new tab.

The button's `textContent` is `History`, but CSS uppercases it, so `drive.mjs
text` and `wait` see `HISTORY` and `RESULTS`. Select on `textContent`, wait on
the uppercase form.

Removing and clearing are destructive to the store, so drive them only against
the scratch profile:

```bash
node apps/cli/bin/gramgrab.mjs history remove ENTRY_ID
node apps/cli/bin/gramgrab.mjs history clear
```

Repair belongs to the dedicated profile and uses the worker target. Save the
current store, replace it with one invalid entry, then list:

```bash
node $D eval "js/background.js" "chrome.storage.local.get('download-history').then(v => JSON.stringify(v['download-history']))" > "$EV/history-store.json"
node $D eval "js/background.js" "chrome.storage.local.set({'download-history':{version:4,entries:[{broken:true}]}}).then(()=> 'written')"
node apps/cli/bin/gramgrab.mjs history list --json
```

The result must report `repaired: true` and no invalid entry. Repeat with one
valid entry next to entries the CLI cannot carry; the list must exit 0 with only
the valid entry:

```bash
node $D eval "js/background.js" "(() => { const e={origin:{kind:'source',sourceUrl:'https://www.instagram.com/instagram/',sourceKind:'profile'},itemIndex:0,mediaType:'image',filenameHint:'instagram_profile',downloadedAt:1700000000000,outcome:'accepted'}; return chrome.storage.local.set({'download-history':{version:4,entries:[{...e,id:'valid'},{...e,id:'empty-hint',filenameHint:''},{...e,id:'negative-time',downloadedAt:-5},{...e,id:'unknown-origin',origin:{...e.origin,kind:'feed'}}]}}).then(()=>'seeded') })()"
node apps/cli/bin/gramgrab.mjs history list --json
```

For the marker, store only the `valid` entry `e` from the seed above, with
`downloadedAt: 0` and `mediaId` set to the `instagram` Avatar's
`mediaIdentity.mediaId` from `gramgrab inspect
https://www.instagram.com/instagram/ --json`. Inspect again; item 1 must carry
`history: {downloaded: true, count: 1, latestDownloadedAt: 0}`.

Restore the saved store before continuing:

```bash
STORE=$(< "$EV/history-store.json")
node $D eval "js/background.js" "chrome.storage.local.set({'download-history':$STORE}).then(()=> 'restored')"
```

Avatar receipts need an Avatar change to prove the refusal, and an account
rarely changes its picture during a run. Save the store as above, then append
one older receipt in each id format for the `instagram` profile:

```bash
node $D eval "js/background.js" "chrome.storage.local.get('download-history').then(v => { const s=v['download-history']; const base={origin:{kind:'source',sourceUrl:'https://www.instagram.com/instagram/',sourceKind:'profile'},itemIndex:0,mediaType:'image',filenameHint:'instagram_profile',outcome:'accepted'}; s.entries.push({...base,id:'legacy-avatar',mediaId:'profile-avatar:instagram',downloadedAt:1700000000000},{...base,id:'older-avatar',mediaId:'profile-avatar:instagram:synthetic_older_picture',downloadedAt:1700000001000}); return chrome.storage.local.set({'download-history':s}).then(()=>'seeded') })"
node apps/cli/bin/gramgrab.mjs history redownload legacy-avatar older-avatar --json
```

Both outcomes must be `HistoryRedownloadFailed` with `WATCH_AVATAR_CHANGED`,
and no new file may land in `$GRAMGRAB_VERIFY_DOWNLOADS`. Read the outcomes,
not the exit code. In the popup, the seeded rows sort first, so
`node $D click "popup.html?surface" ".history-redownload"` must show `Avatar
changed. ... History was kept.` For the positive case, export item 1 of
`https://www.instagram.com/instagram/`; its receipt's `mediaId` is
`profile-avatar:instagram:<pictureId>`, and re-downloading it starts a download.
Restore the store afterwards.

Repeat once with `{version:999,entries:[]}`. Opening history in the UI must show
`Download history uses a newer version.`, the presentation of
`HISTORY_VERSION_UNSUPPORTED`; `history list --json` must reject with
`Unsupported history version.` Restore again. Never perform corruption checks
on a non-verification profile.

## What proves it works

- After a real download, `history list` gains an entry whose item number and
  source match what was downloaded, and the same entry appears under the
  `Download history` section in the UI. Check both surfaces; they read the same
  store through different paths.
- `history remove ENTRY_ID` drops exactly that entry and leaves the rest.
- `history clear` empties it, and the UI shows the cleared state without a
  reload.
- A malformed supported store reports `repaired: true`. A future store version
  remains untouched and produces the surface-specific failures above.
- List entries saved with direct, frame, and silent export settings after a
  browser restart. `history list --json` must succeed and retain each entry's
  `exportMode`, `frameTimestampSeconds`, `rotation`, and `crop`. Only Watches exports
  add `requestedExport` and `recovery`. Match the CLI entry count to the UI and
  require `repaired: false` for a valid store.
  Keep identifiers and media URLs out of shared evidence. Use synthetic entries
  in a scratch profile if those export modes are unavailable, then restore its
  original store.
- A WhatsApp receipt shows no display name and no re-download button. Its only
  control is `Remove WhatsApp receipt from history`. That absence is the
  feature, so capture it.

## Gotchas

- History is per-profile browser storage, and the profile persists, so entries
  from earlier runs are still there. An empty list on a brand-new profile proves
  nothing; a list carrying yesterday's entries is the store working. Fill it with
  a real download before judging either way.
- `history clear` on the developer's own profile destroys their real record.
  Confirm which socket the CLI is pointed at before running it.
- Re-download goes back to Instagram and can fail for the same reasons a fresh
  fetch can, including rate limits. A failing re-download is not automatically a
  history bug.
