# Download history

A record of what GramGrab already saved, so a person can see what they have and
fetch something again without hunting for the URL.

## Sub-features

- List, with a per-item downloaded-at timestamp and an `Open source` link back
  to Instagram.
- Re-download a single entry.
- Remove one entry, or clear everything.
- Repair: a corrupt store is rebuilt rather than thrown away, reported as
  `repaired: true` on a list.
- WhatsApp receipts, which are deliberately weaker: a receipt has no display
  name and no re-download affordance. Only removal applies.

## How to get to it (user POV)

Click `History` in the popup or workspace header. The button toggles to
`Results` while history is showing. `gramgrab history list` prints the same
store.

## Driving it with the harness

```bash
cd /home/arnab/Projects/GramGrab && . ./.local/verify/session.env
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
node $D eval "background.js" "chrome.storage.local.get('download-history').then(v => JSON.stringify(v['download-history']))" > "$EV/history-store.json"
node $D eval "background.js" "chrome.storage.local.set({'download-history':{version:4,entries:[{broken:true}]}}).then(()=> 'written')"
node apps/cli/bin/gramgrab.mjs history list --json
```

The result must report `repaired: true` and no invalid entry. Restore the saved
store before continuing:

```bash
STORE=$(< "$EV/history-store.json")
node $D eval "background.js" "chrome.storage.local.set({'download-history':$STORE}).then(()=> 'restored')"
```

Repeat once with `{version:999,entries:[]}`. Opening history in the UI must show
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
