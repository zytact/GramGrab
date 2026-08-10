# Instagram privacy and security constraints

These constraints govern Instagram acquisition, shareable diagnostics, protocol refreshes, and
committed response fixtures. They are binding on every ticket and change that touches the Instagram
path. This document consolidates existing commitments; it does not authorize new collection,
retention, or use of Instagram data.

## Acquisition boundary

Instagram acquisition runs from the extension background worker. It does not inspect Instagram
pages through a content script. The manifest grants access to `https://*.instagram.com/*` for media
metadata and `https://*.fbcdn.net/*` for media previews and downloads. Those permissions are for the
requested GramGrab operation, not unrelated browsing or session state.

## Authentication material

Instagram requests may use the browser's authenticated session where required. The `cookies`
permission is limited to reading Instagram's `csrftoken` cookie for an Instants request and sending
that value back to Instagram as the CSRF header for that request.

Cookies, CSRF tokens, request headers, browser storage contents, and unrelated session state never
enter shareable diagnostics or committed artifacts. They must not be copied into source,
configuration, fixtures, documentation, logs, or issues.

## Shareable diagnostics

Copied diagnostics follow the failure policy in [the error model](./error-model.md) and the
structural-only contract here. A report is built from an allowlisted schema and must have no field
capable of carrying a raw signed media URL, literal Instagram source URL, filename, operation or
request identifier, arbitrary technical cause, full user-agent string, cookie, request header,
browser storage content, or unrelated session state. Parsing failures never fall back to raw input.

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
