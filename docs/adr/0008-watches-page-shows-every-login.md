# The Watches page shows every login's Watches

Since [ADR 0007](./0007-linked-second-instagram-login.md) a profile can hold a main and a linked login, and both logins' Watches run while the profile is open. The Watches page still showed one login at a time behind two tabs, and Watches of any other login appeared only as a count. The privacy contract said another login "cannot see or use" a Watch. That hid nothing: Watch state sits unencrypted in `storage.local`, so anyone with the browser can read it in DevTools.

This supersedes the visibility half of the ownership rule in `docs/instagram-privacy.md` and the sentence in ADR 0007 that says the page shows one login at a time. Ownership still decides which session checks a Watch and which login can change it. It no longer hides a Watch from the page.

## Decisions

- **One page, one read per login.** The page reads the main login's `WatchList`, and the linked login's while it is linked, then merges them. The linked list is read first, so a linked session that turns out to be ended already shows as held in the main list. The protocol keeps its per-login reads, and the CLI keeps `--login` as both the routing and the filter for `watch list`.
- **Every command runs as the Watch's owner.** The page knows each Watch's owner from the list it came from, and sends pause, delete, settings, Check now, recovery, and inbox commands as that login. An inbox action that spans both logins sends one command per login. Selectors still match only the requesting login's Watches, so a command can never change another login's Watch.
- **Held Watches.** `WatchListResult.heldWatches` replaces `otherLoginWatchCount`. It lists each Watch no signed-in login checks: the linked login's after Instagram ended its session (`owner: 'linked'`), and any Watch whose owner is neither the main nor the linked login (`owner: 'other'`). The page shows them greyed out and paused, and offers no command for them. Relinking the same account, or signing in as the other login, resumes them as before. GramGrab stores no username for another login, so the page names it only as another login.
- **Avatars of every Watch.** `WATCH_AVATARS` returns the cached Avatar of every Watch, whichever login owns it, plus the asking login's own picture.
- **Picking the owner.** While a login is linked, Add Watch and Export or import show a login picker that defaults to the main login. The account preview resolves as the chosen login, and an import adds every Watch in the file to that one login. The file still names no login, as [ADR 0006](./0006-watches-file-carries-definitions-only.md) decided.
- **Per-login holds.** Each login has its own ledger and schedule, so the page shows each login's rate-limit pause, hourly cap, or suspended session labelled with that login.

## Considered options

- **A protocol read across logins.** One `WatchList` would return both logins' Watches. It saves the page one message, but every reply would need an owner on each summary and both logins' schedules, and the CLI would gain a second meaning for `--login`. Two reads reuse the verified per-login path as it is.
- **Keep the tabs.** Nothing to build, but a person with two logins keeps switching between two copies of the same page to see what they watch.

## Consequences

- The CLI protocol is version 7, since `WatchListResult` changed shape.
- `gramgrab watch list` shows held Watches of other logins in its JSON reply instead of a count.
- A main login that GramGrab cannot verify still shows only the sign-in page, even while the linked login is live. The linked login's Watches keep running in the background.
