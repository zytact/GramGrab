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

- **Consent.** The person acknowledges this disclosure every time they add a Watch, on the options page
  or with `gramgrab watch add --accept-unattended`:

  > Watches check Instagram for you about twice a day while your browser is open, using your
  > signed-in Instagram session, even when you are not using GramGrab. Instagram may treat this
  > automated activity as unusual and could limit or flag your account. GramGrab stores only the
  > account and media IDs and check results it needs, on this device, never media files or media
  > links. You can pause or delete a Watch at any time.

- **Requests.** Unattended requests are limited to the profile, Stories, Instants, and Posts requests
  for enabled Watches, plus a search request that looks up an initial Avatar when its check omitted
  the Avatar kind, or refreshes a Watch that does not watch Avatar changes. These lookups run at most
  once a week, including failed attempts; request-cap deferrals do not count as attempts. They run
  only while the creating Instagram login is verified, and the Watch cadence and rate policy bounds
  them. Watch auto-downloads and Avatar images fetch from the CDN. A notification icon loads into
  memory and is dropped after use. The login's own Avatar comes from the viewer query that verifies
  the login, so showing it costs no request; it is held in worker memory only.
- **Stored state.** The Watch store lives in `storage.local` and holds only what its allowlisted
  Effect schema permits:
  - IDs: the creating viewer ID, the target account ID, and the target's current and previous usernames
  - settings: the chosen kinds and actions, and whether the Watch is enabled or paused
  - per kind: the baseline cutoff, the seen media IDs with publication times, and the last check
    status, code, and time
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
  viewer's own username and Avatar are fetched when needed and are not stored. A Posts traversal
  cursor lives only in `storage.session`.

- **Ownership and lifetime.** Watch state belongs to the Instagram login that created it, and
  another login cannot see or use it. Inbox entries expire 30 days after discovery. The whole store
  stays under a 2 MiB budget. Deleting a Watch removes its state, while downloaded files and History
  receipts remain.

## Authentication material

Instagram requests may use the browser's authenticated session where required. The `cookies`
permission is limited to reading Instagram's `csrftoken` cookie immediately before an Instagram
request that requires it, such as Instants, Posts, or the profile query, and sending that value back
to Instagram as the CSRF header for that request. The value is never stored or logged.

Cookies, CSRF tokens, request headers, browser storage contents, and unrelated session state never
enter shareable diagnostics or committed artifacts. They must not be copied into source,
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
