# Any signed-in login can change, delete, or move any Watch

[ADR 0008](./0008-watches-page-shows-every-login.md) let the Watches page show every login's Watches but kept changes to the owner. That stranded Watches. When a linked login's account is gone for good, its Watches sat held forever: no one could delete them, edit them, or hand them to another login. Ownership was never a security boundary. Watch state sits unencrypted in `storage.local`, so the rule only got in the person's way.

This supersedes the sentence in ADR 0008 that says selectors match only the requesting login's Watches, and the half of the ownership rule in `docs/instagram-privacy.md` that says only the owner can change a Watch.

## Decisions

- **A Watch ID names any Watch.** `WatchIdSelector` picks one stored Watch by its ID, whichever login owns it. `WatchSet` and `WatchLifecycle` accept it, so pause, resume, delete, and settings work on a held Watch or on the other login's Watch. Account ID and username selectors still pick among the requesting login's Watches, because one account can have a Watch under each login and a username alone would be ambiguous.
- **Ownership still decides who checks.** Only the owner's session checks a Watch, runs its actions, and exports its inbox. `WatchCheck`, `WatchShow`, and the inbox commands keep matching only the requesting login's Watches.
- **Moving a Watch.** `WatchTransfer` moves the named Watches to the login the command runs as. It changes the stored owner and keeps the Watch ID, baselines, seen media, inbox, and cached Avatar, so the new owner's next check carries on where the old one stopped. Work the old owner had in flight finds the Watch gone and stops. A Watch whose account the login already watches stays where it is and comes back in `alreadyWatched`, since two Watches of one account under one login would collide on every account selector.
- **Any login can be the destination.** The page offers every signed-in login other than the owner, so a Watch can move from the main login to the linked one, back again, or out of a held state to either.

## Considered options

- **Re-add instead of move.** Export the Watch, delete it, and import it as the other login. It works today, but it throws away baselines and the inbox, and it cannot reach a held Watch, since export reads only the requesting login's Watches.
- **Let every selector match every login.** One rule for every command, but `watch delete instagram` would delete both logins' Watches of that account.

## Consequences

- The CLI protocol is version 8, since `WatchSelector` and `WatchCommand` changed.
- `gramgrab watch transfer WATCH_ID... --login main|linked` moves Watches, and any `WATCH` argument may be a Watch ID from `watch list`, held Watches included.
- A moved Watch's baselines came from what the old login could see. If the new login cannot see a private account, its next check reports that problem like any other.
