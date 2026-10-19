# One browser profile may hold a linked second Instagram login (Beta)

Some private accounts are visible to a person's second Instagram account and not to their main one. Until now the only way to watch them was a second browser profile, and its Watches stopped whenever that profile was closed. We now let one profile hold one linked second login. Watches it creates run from the main profile, and the popup, workspace, and CLI can fetch as it. It ships as a Beta for Chromium only, and all of it sits behind `apps/extension/src/instagram/linked-login.ts` and its callers, so removing it leaves the main login as it was.

This supersedes the sentence in [ADR 0005](./0005-unattended-instagram-access-for-watches.md) that says Watch state never holds session material. Watch state still holds none. The linked login's cookies are a separate record, described below.

## How it works

- The person signs in to the second account in an Incognito window and clicks "Link this login" on the Watches page. GramGrab must be allowed in Incognito, which is a manual browser toggle. GramGrab reads that window's `instagram.com` cookies with `cookies.getAll({ storeId })`, confirms the account with the viewer query as the new login, and refuses it when it is the main login. The person may then close the Incognito window without logging out.
- `InstagramRequests` is the one place that knows which login a request belongs to. A linked request carries the `gg_login=linked` query parameter and `credentials: 'omit'`, and its `X-CSRFToken` is the linked login's `csrftoken`. A `declarativeNetRequest` session rule that matches the marker, `instagram.com` request domains, and requests outside tabs (`tabIds: [-1]`) sets the `Cookie` header. A page in a tab can never borrow the linked cookies by adding the marker. Session rules do not survive a browser restart, so the worker installs the rule again on start.
- A `webRequest.onHeadersReceived` listener reads `Set-Cookie` on marked responses only and updates the stored cookies and the rule. Instagram replaces `rur` on almost every response, so a copy that ignored it would go stale.
- Each login has its own request ledger. A 429 on one login never pauses the other.
- A Watch belongs to the login that created it, as before. Each Watch check, action, notification, and Avatar lookup runs as its owner. The Watches page shows one login at a time, and adding or importing a Watch adds it to the login on show.
- When the linked login's viewer query finds no signed-in viewer, the record is marked ended. Its Watches stop, one `linked-login` attention item appears, and the popup picker shows the linked login as signed out. Linking the same account again resumes them. Another account does not adopt them.
- CDN media and Avatar bytes are signed URLs on `fbcdn.net`, which never received Instagram cookies, so they need no routing.

## Stored state

While a login is linked, `storage.local` holds `linked-instagram-login`: its account ID, a copy of its Instagram cookies, and whether its session ended. The cookies are unencrypted at rest, like the browser's own cookie store on most platforms. Unlink deletes the record and the rule. The linked login's username is fetched, never stored. Diagnostics never contain the cookies, the account ID, or the username.

## Considered options

- **A second browser profile.** This is the status quo. It needs no stored session, but its Watches run only while that profile is open.
- **Firefox containers.** They isolate cookies per container natively, but they exist only in Firefox and need a container-aware request path GramGrab does not have.
- **Pasting cookies by hand.** It avoids Incognito, but asks the person to copy session secrets through the clipboard. Out of scope.

## Consequences

- The Chromium manifest adds `declarativeNetRequestWithHostAccess` and `webRequest`. The Firefox build declares neither, so the feature is hidden there.
- The `cookies` permission now also copies the Incognito window's Instagram cookies when the person links a login.
- The CLI protocol is version 5: a request may name `login`, and an older extension would otherwise run a linked request as the main login.
- Instagram can end the linked session at any time, and logging out of the second account anywhere ends it.
