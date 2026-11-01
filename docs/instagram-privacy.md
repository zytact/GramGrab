# Instagram privacy and security constraints

These constraints govern Instagram acquisition, shareable diagnostics, protocol refreshes, and
committed response fixtures. They are binding on every ticket and change that touches the Instagram
path. This document consolidates existing commitments; it does not authorize new collection,
retention, or use of Instagram data.

## Acquisition boundary

Instagram acquisition runs from the extension background worker. It does not inspect Instagram
pages through a content script. The manifest grants access to `https://*.instagram.com/*` for media
metadata and `https://*.fbcdn.net/*` for media previews and downloads. Those permissions are for the
requested GramGrab operation or a consented Watch check, not unrelated browsing or session state.

## Watches

Watches are the one exception to request-in-the-moment access. See
[ADR 0005](./adr/0005-unattended-instagram-access-for-watches.md).

- **Consent.** The person acknowledges this disclosure every time they add a Watch on the options
  page or with `gramgrab watch add --accept-unattended`, and once for each file they import:

  > Watches check Instagram for you about twice a day while your browser is open, using the
  > session of the Instagram login that adds them, even when you are not using GramGrab. Instagram may treat this
  > automated activity as unusual and could limit or flag your account. GramGrab stores only the
  > account and media IDs and check results it needs, on this device, never media files or media
  > links. You can pause or delete a Watch at any time.

  A Watch of the linked second login uses that login's session the same way. See Linked login
  below.

- **Requests.** Unattended requests are limited to the profile, Stories, Instants, and Posts requests
  for enabled Watches, plus a search request that looks up an initial Avatar when its check omitted
  the Avatar kind, or refreshes a Watch that does not watch Avatar changes. These lookups run at most
  once a week, including failed attempts. Unspent deferrals and login-change cancellations do not
  count as attempts. They run only while the creating Instagram login is verified, and the Watch
  cadence and rate policy bound them. Watch auto-downloads and Avatar images fetch from the CDN.
  Notifications use the cached Watch Avatar without another CDN request.
  The login's own Avatar comes from the viewer read that verifies
  the login, so showing it costs no request; it is held only in memory.
- **Stored state.** The Watch store lives in `storage.local` and holds only what its allowlisted
  Effect schema permits:
  - IDs: the creating viewer ID, the target account ID, and the target's current and previous usernames
  - settings: the chosen kinds and actions, and whether the Watch is enabled or paused
  - per kind: the baseline cutoff, the seen media IDs with publication times, and the last check
    status, code, and time. Seen media includes what the person fetched by hand, as described
    under Fetched media
  - media references: shortcodes, media IDs, Sidecar child IDs, media type, publication time, Story
    expiry time, and discovery time
  - Avatar picture identities: the last one observed and one for each recorded change
  - one cached Avatar image per Watch: a center-cropped 80 by 80 pixel JPEG of at most 8 KiB, with
    its picture identity and when the image was cached. It is loaded again only when the
    identity changes, and deleting the Watch removes it. A separate lookup timestamp bounds failed
    refresh attempts. Optional image updates that exceed the store budget are skipped.
  - per-action and per-child outcomes, Watch attention items, and Watch inbox entries

  Apart from those Avatar images, it never holds media bytes or thumbnails. It never holds signed,
  preview, data, or blob URLs, captions, full or display names, locations, cookies, or tokens. The
  viewer's own Avatar is fetched when needed and is not stored. Each login's verified account ID
  and username live only in `storage.session`, which the browser clears when it closes, so the
  login picker can name them. The linked login's cookies are a
  separate record, not Watch state; see Linked login. A Posts traversal
  cursor lives only in `storage.session`. Each Watch entry links to its Instagram page, built
  when shown from the username and the stored shortcode or Story ID; the link is never stored.

- **Fetched media.** When the person fetches a Post, Sidecar, Story, or Instant in the popup,
  workspace, or CLI, GramGrab adds its media ID and publication time to the seen media of the
  verified login's Watches of its author or co-authors, so their next check skips it. It confirms
  the login with one viewer request, and only when such a Watch exists. It records nothing for an
  account without a Watch, for media inside a Watch's baseline or older than 30 days, for a
  Highlight, or for an Avatar. An entry already in the Watch inbox stays there.

- **Export and import.** The options page can save one verified login's Watches to a file and add
  the Watches in such a file to one verified login, picked on the page while a login is linked.
  The file holds each target account ID and username, its kinds and actions, and whether it is
  paused. It holds no viewer ID, baseline, media reference, outcome, or Avatar image, and GramGrab
  sends it nowhere. Import shows what it will add, requires the disclosure above, and confirms each
  account it adds with one ID-keyed profile request. See
  [ADR 0006](./adr/0006-watches-file-carries-definitions-only.md).

- **Ownership and lifetime.** Watch state belongs to the Instagram login that created it. Only
  that login's session checks it, and only that login can change it. The Watches page lists every
  stored Watch, and a Watch whose owner is not signed in shows as paused. See
  [ADR 0008](./adr/0008-watches-page-shows-every-login.md). Inbox entries expire 30 days after
  discovery. The whole store stays under a 2 MiB budget. Deleting a Watch removes its state, while
  downloaded files and History receipts remain.

## Linked login (Beta, Chromium)

One browser profile may hold one linked second Instagram login. See
[ADR 0007](./adr/0007-linked-second-instagram-login.md).

- **Linking.** The person signs in to the second account in an Incognito window and clicks "Link
  this login" on the Watches page. GramGrab reads that window's `instagram.com` cookies once,
  confirms the account with the viewer read, and refuses the main login.
- **Stored state.** While a login is linked, `storage.local` holds its account ID, a copy of its
  Instagram cookies, unencrypted at rest, and whether Instagram ended its session. Its username is
  kept only in `storage.session`, never in `storage.local`. Unlink deletes the record and the request rule.
- **Requests.** Only GramGrab's own requests for that login carry its cookies: they are marked,
  omit the browser's cookies, and a session rule that matches only requests outside tabs adds the
  linked cookies. `Set-Cookie` on those responses updates the stored copy and never touches the
  main login's cookies. Each login has its own request ledger.
- **Ending.** When Instagram ends the session, its Watches stop until the same account is linked
  again. Another account never adopts them.

## Authentication material

Instagram requests may use the browser's authenticated session where required. The `cookies`
permission reads Instagram's `csrftoken` cookie immediately before an Instagram request that
requires it, such as Instants, Posts, or the profile query, and sends that value back to Instagram
as the CSRF header for that request. That value is never stored or logged. The only other use is
copying the Incognito window's Instagram cookies when the person links a second login, as Linked
login describes.

Instagram's Posts queries also need the `fb_dtsg` form token. GramGrab reads it from the
instagram.com home page, keeps it in the background worker's memory only, and sends it back to
Instagram with those queries, one token per login. The same read names the signed-in viewer. The
worker keeps each login's last viewer read, with the `sessionid` value it was read under, in memory
only for up to 5 minutes, so work the person starts can skip a repeat read while that cookie is
unchanged. The `declarativeNetRequestWithHostAccess`
permission sets two headers on GramGrab's own requests to instagram.com, never on a tab's:
`Origin: https://www.instagram.com` on its POST requests, and the linked login's `Cookie` on
requests made for that login.

Cookies, CSRF tokens, request headers, browser storage contents, and unrelated session state never
enter shareable diagnostics or committed artifacts. Neither does the linked login's account ID or
username. They must not be copied into source,
configuration, fixtures, documentation, logs, or issues.

## Shareable diagnostics

Copied diagnostics follow the failure policy in [the error model](./error-model.md) and the
structural-only contract here. A report is built from an allowlisted schema and must have no field
capable of carrying a raw signed media URL, literal Instagram source URL, filename, operation or
request identifier, arbitrary technical cause, full user-agent string, cookie, request header,
browser storage content, or unrelated session state. Parsing failures never fall back to raw input.

A Watch failure adds only a closed media-kind field to the code, phase, and scope. Reports never
contain usernames, account or media IDs, shortcodes, cursors, timestamps, or other Watch store
content.

A person previews the complete serialized report before copying it. Reports are generated
transiently and are never uploaded, archived, or collected as telemetry by GramGrab.

## Protocol refreshes

A copied Instagram request used to refresh protocol metadata contains session credentials. It is
read from standard input only and must never be saved to a file, pasted into an issue or chat, or
committed. The updater extracts only the public allowlist documented in
[the Instagram protocol refresh guide](./instagram-protocol.md).

The committed protocol configuration never contains cookies, CSRF or LSD tokens, usernames,
account IDs, media identifiers, request bodies, GraphQL variables, or response fixtures.

## Response fixtures

Raw Instagram responses stay in the local `.local/raw-fixtures/` directory and are never committed.
They must be inspected only on the local machine and never pasted into issues, source, snapshots,
documentation, or logs.

The Instagram fixture sanitizer is the privacy boundary for committed captures. It fails closed on
every unreviewed path or primitive type, replaces identifying, descriptive, location, media, URL,
token, cursor, and other opaque values with synthetic values, and emits only value-free diagnostics.
Committed fixture URLs use `https://sanitized.invalid/`; no original host, path, query, signature,
or fragment survives. See [the sanitizer contract](../apps/extension/scripts/ig-fixture-sanitizer/README.md).

## Enforcement

- Keep acquisition permissions purpose-specific in the generated manifest and its permission-reason
  registry.
- Make shareable diagnostics an allowlisted Effect schema and constructor, not a redaction pass over
  a general runtime object.
- Decode Instagram responses through strict Effect schemas.
- Run the fail-closed sanitizer before replacing committed response fixtures.
- Treat documentation and code review as explanations of these boundaries, not their enforcement.
