# A Watches file carries Watch definitions only

A person can export their Watches to a file on the options page and import that file into another GramGrab install. The file is JSON with `format: "gramgrab-watches"` and `version: 1`, decoded through `WatchesFile` in `packages/protocol/src/watch.ts`. Each Watch in it is the target account ID, its username, the chosen kinds and actions, and whether the Watch is paused. An unknown field, an unknown version, or an account listed twice fails the decode, and nothing is imported. The schema carries that strictness itself, so it holds for every caller and not only the options page.

Issue 286 also listed per-Watch export settings. A Watch stores none today, so the file has none.

## Decisions

- **Nothing a check found travels.** Baselines, seen media, discoveries, Watch inbox entries, attention items, check problems, and cached Avatar images stay out. An imported Watch starts with no baseline, so its first check records what is already there and acts on nothing. Carrying a baseline over would mark media as seen that this install never checked.
- **An account already watched is skipped.** The existing Watch keeps its settings, baseline, and inbox. The preview lists skipped accounts separately. Merging would change a Watch the person did not open, and asking per account adds a step for a case `WatchSet` already covers.
- **The file names no Instagram login.** Import adds the Watches to whichever login is verified at that moment. A file bound to one login could not move Watches to a second account, and it would put the person's own account ID in a file they may share.
- **Import confirms each added account by its ID.** A file can be hand-edited or shared, so its username is only a label for the preview, which also shows the account ID. Import sends the ID-keyed profile query once per account it will add and stores the username Instagram returns, the same rule `WatchAdd` follows. An account already watched costs no request. Trusting the file instead would let a wrong username stay forever on a Watch that tracks only Stories or Instants, because only Posts and Avatar checks confirm it.
- **A failed confirmation does not undo the rest.** An account Instagram does not confirm is left out and reported. Any other failure, a rate limit included, stops the import there: the accounts confirmed so far are added, and the result says how many were not tried. Importing the same file again later adds the rest, since Watches it already added are skipped.
- **Import requires the unattended disclosure.** Importing creates Watches, so [ADR 0005](./0005-unattended-instagram-access-for-watches.md) applies: the person acknowledges the disclosure once per import, and `WatchesImport` is rejected with `WATCH_UNATTENDED_NOT_ACCEPTED` without it.

## Consequences

- The file leaves the browser only when the person saves it. GramGrab sends it nowhere, so Firefox still declares no data collection.
- An import costs one Instagram request per added Watch, plus the viewer query. They are person-initiated requests, so they count toward the hourly total that holds Watch checks back.
- `WatchesExport` and `WatchesImport` are protocol commands, so the native host accepts them, but the CLI has no verb for them yet.
