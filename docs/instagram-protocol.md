# Refreshing Instagram protocol metadata

Post and Shortcode Reel acquisition first decodes the shortcode to a numeric media ID and reads
`/api/v1/media/{id}/info/`. The configured `mediaByShortcode` GraphQL candidates run only if that
request has a transport or non-terminal HTTP failure. Authentication, rate limits, and a changed
successful REST response surface directly. Refresh these GraphQL candidates when the fallback is
needed and a relevant GraphQL request can be observed; a changed REST response instead needs a
schema and sanitized fixture update.

GramGrab keeps public Instagram request metadata in
[`apps/extension/src/instagram-protocol/config.json`](../apps/extension/src/instagram-protocol/config.json). The extension and the
generated fixture capture script both consume this file, so protocol values must not be copied into
their source files.

The configuration contains only:

- the default Instagram App ID and ASBD ID
- operation-specific public app-ID overrides and friendly names
- GraphQL `doc_id`, `client_doc_id`, and `query_hash` candidates
- GraphQL endpoints and transports
- the fallback order for each existing request family

It must never contain cookies, CSRF or LSD tokens, usernames, account IDs, media identifiers,
request bodies, GraphQL variables, or fixture responses.

## Known server behavior

Instagram answers some requests in ways that look like GramGrab bugs. Each item below was observed
live. Check this list before debugging an Instagram failure.

- **The REST username lookups are gone for a signed-in session.** Since October 2026,
  `users/web_profile_info/` and `users/{id}/info/` answer 429 and `web/search/topsearch/` answers
  404 ([#301](https://github.com/zytact/GramGrab/issues/301)). GramGrab resolves a username to an
  account ID from the account's own Posts (`profilePosts`), or from the `profile_id` its profile
  page names when it has no Posts (`resolveUsernameToId` in
  `apps/extension/src/instagram/acquisition.ts`). A Post's `user` can be a collab owner, so only a
  record with the requested username counts.
- **The Posts queries need Instagram Web's own Origin and `fb_dtsg`.** Since October 2026,
  `profilePosts` and `profilePostsPage` answer the instagram.com home page as HTML unless the request
  goes to `/api/graphql`, carries the `fb_dtsg` form token, and sends
  `Origin: https://www.instagram.com` ([#313](https://github.com/zytact/GramGrab/issues/313)).
  `fetch` cannot set `Origin`, so `installInstagramOrigin` in
  `apps/extension/src/instagram/origin.ts` adds a session rule that sets it on the extension's own
  POSTs to instagram.com. `withDtsgToken` in `apps/extension/src/instagram/dtsg.ts` reads the
  token from the home page, and reads it again once when a cached token gets HTML back.
- **The `viewer` query is gone.** Since October 2026, the `query_hash` viewer query, GET or POST,
  and `api/v1/accounts/current_user/` answer the instagram.com home page as HTML
  ([#354](https://github.com/zytact/GramGrab/issues/354)). Watches read the signed-in viewer from
  the home page's `"PolarisViewer",[],{"data":…}` block instead (`fetchViewer` in
  `apps/extension/src/watch/identity.ts`). A signed-out page names `"data":null`. The same read
  refreshes the login's `fb_dtsg` token (`readHomePage` in `apps/extension/src/instagram/dtsg.ts`),
  and stops downloading once the page has named both, about the first 260 KB of 1.27 MB. Work the
  person starts reuses a viewer read from the last 5 minutes while the login still sends the same
  `sessionid` cookie (`recentViewer`). Unattended Watch work always reads the page again.
- **The Stories query moved to Instagram Web's Story page query.** Since late October 2026, the
  `reelsMedia` `query_hash` request, GET or POST, answers the instagram.com home page as HTML
  ([#357](https://github.com/zytact/GramGrab/issues/357)). GramGrab sends
  `PolarisStoriesV3ReelPageStandaloneQuery` to `/api/graphql` with `fb_dtsg` (`requestReels` in
  `apps/extension/src/effect/instagram.ts`). One query serves both kinds: `reel_ids_arr` holds an
  account ID for its Stories or `highlight:<id>` for a Highlight. Items are `XDTMediaDict`s whose
  `id` is `<pk>_<owner ID>`, so GramGrab names a Story by its `pk`.
- **A Posts page can carry a `field_exception` on a field GramGrab never reads.** In October 2026
  one Post's `location.profile_pic_url` errored while all 12 edges and the cursor came back. A
  Watch ignores an error whose path ends under a Post field `PostNode` does not decode.
- **`profileById` carries the Avatar but no picture ID.** It answers `profile_pic_url` and
  `hd_profile_pic_url_info`, and no `profile_pic_id`. A Watch identifies its Avatar by the asset
  name in the picture URL, which stays the same across sizes and signed URLs.
- **The Highlights tray answered 403 in October 2026.** GramGrab swallows it, so a profile resolves
  to its Avatar and no Highlight covers.
- **The web GraphQL host answers the Instants query with `null`.** Since October 2026,
  `www.instagram.com/graphql/query` returns HTTP 200, no `errors`, and a `null`
  `xdt_get_quick_snaps` for every `client_doc_id` and app ID tried. GramGrab sends Instants to
  `i.instagram.com/graphql_www` with the Moonshot app ID instead, which still returns the feed
  ([#295](https://github.com/zytact/GramGrab/issues/295)). Send only `fb_api_req_friendly_name`,
  `client_doc_id`, `variables`, and `server_timestamps`: the `enable_canonical_naming*` flags rename
  the root field to `1$xdt_get_quick_snaps(request:$request)`.
- **Instagram Web never sends the Instants query.** `IGQuickSnapGetQuickSnapsQuery` comes only from
  the mobile apps, so its `client_doc_id` cannot be captured from instagram.com. Its persisted ID
  changes with most Instagram app releases; take the current one from
  [Reference sources](#reference-sources).

## Reference sources

These outside sources cover what instagram.com cannot show. They change with every Instagram
release, so read them live instead of vendoring them under `.repos/`.

| Source                                                                                                      | What GramGrab takes from it                                                                                                                                                                                       | Reach for it when                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`Nader-abdi/instagram-persisted-query-diff`](https://github.com/Nader-abdi/instagram-persisted-query-diff) | Persisted `client_doc_id` values per Instagram Android build. `index.json` lists every build-to-build diff; each `diff.json` names the operations that were added, removed, or changed.                           | An operation that Instagram Web never sends, such as `instantsFeed`, needs a current ID. Take the newest diff that touches the operation. |
| [`williamcachamwri/quicksnapins-api`](https://github.com/williamcachamwri/quicksnapins-api)                 | Unofficial client built from the decompiled Instants iOS app (`com.burbn.moonshot`). Source of the Moonshot app ID `124024574287414`, the `i.instagram.com/graphql_www` endpoint, and the QuickSnap request body. | The Instants request itself, not just its ID, stops working.                                                                              |
| [`subzeroid/instagrapi`](https://github.com/subzeroid/instagrapi)                                           | Widely used unofficial Python client for Instagram's private mobile API. `instagrapi/mixins/quicksnap.py` confirms the QuickSnap request pattern.                                                                 | A second, independent reading of a mobile request is needed.                                                                              |

QuickSnap is Instagram's internal name for Instants. Search these sources for `QuickSnap`, not
`Instant`.

## Operation names

The updater requires an explicit operation because it does not classify captured traffic:

| Operation          | Existing GramGrab request family                        |
| ------------------ | ------------------------------------------------------- |
| `mediaByShortcode` | Posts, Reels, and sidecars fetched from a shortcode     |
| `reelsMedia`       | Stories and Highlights fetched through reels media data |
| `profileById`      | An account's current username and Avatar by ID          |
| `profilePosts`     | An account's first Posts page, and a username's ID      |
| `profilePostsPage` | Watches: a later Posts grid page, by cursor             |

These are configuration keys for existing code paths. They do not represent separate discovery
problems, and values such as `shortcode` and `reel_ids_arr` are runtime inputs,
not protocol metadata.

## Capture a relevant request

Use a browser profile that is already logged in to Instagram:

1. Open DevTools and select the Network panel.
2. Trigger the GramGrab request family that needs updating:
   - open a Post, Reel, or sidecar for `mediaByShortcode`
   - open an account's profile for `profilePosts` (the `PolarisProfilePostsQuery` request)
   - scroll that profile's grid for `profilePostsPage` (the
     `PolarisProfilePostsTabContentQuery_connection` request)
3. Select the relevant Instagram GraphQL request.
4. Choose **Copy** > **Copy as fetch**.

`instantsFeed` has no web request to capture, and `reelsMedia` usually has none either; see
[Update the configuration](#update-the-configuration).

One relevant copied request is enough for each operation being refreshed. If both request families
need updating, repeat the updater once for each operation. You do not need separate requests for
images, videos, sidecars, Stories, and Highlights.

The copied request contains session credentials. Do not save it to a file, paste it into an issue or
chat, or commit it. The updater reads it only from stdin and never evaluates the copied JavaScript.

## Update the configuration

For Posts, Reels, and sidecars, run:

```bash
vp run update:ig-protocol --operation mediaByShortcode
```

Instagram Web embeds the Stories query in a Story page's HTML instead of sending it. Open
`view-source:` on a Story or Highlight URL and search for `PolarisStoriesV3ReelPageStandaloneQuery`.
The `queryID` next to it is the `doc_id`. Replace the `reelsMedia` candidate's `id` in `config.json`
by hand. If DevTools does show that request, the updater accepts it with
`vp run update:ig-protocol --operation reelsMedia`.

Active Instants have no captured request to paste, so the updater does not accept `instantsFeed`.
Replace the `client_doc_id` in the `instantsFeed` candidate of `config.json` by hand with the
newest one from [Reference sources](#reference-sources). GramGrab sends only the first Instants
candidate, so an older one is never tried.

For a Watch operation, pass its name the same way, for example
`vp run update:ig-protocol --operation profilePosts`. After refreshing one, rerun the affected Watch
live verification rows.

Paste the complete Copy-as-fetch request into the waiting terminal, then press Ctrl-D to end stdin.
The updater extracts only the allowed public metadata, validates the resulting configuration through
Effect Schema, and atomically rewrites `apps/extension/src/instagram-protocol/config.json`.

The observed candidate becomes the first candidate for the selected operation. Existing candidates
remain behind it as ordered fallbacks. Running the updater for one operation does not replace the
other operation.

## Review and validate

Inspect the complete configuration change:

```bash
git diff HEAD -- apps/extension/src/instagram-protocol/config.json
```

Confirm that the diff contains only the allowed fields listed above. Then run the repository checks
in order:

```bash
vp check
vp test run
vp run fallow
```

The configuration-driven fallback tests must pass with the newly observed candidate order. Commit
the protocol JSON, updater, consumers, and tests together.

## Refresh fixtures when the response shape also changed

Protocol metadata and response fixtures solve different failures. Updating a request identifier may
restore the request without requiring new fixtures. If Instagram also changed the returned JSON
shape:

1. Configure private capture subjects in the repository-root `.env`.
2. Run `vp run generate:ig-fixtures`.
3. Paste `.local/capture-ig-fixtures.mjs` into DevTools on `https://www.instagram.com`.
4. Sanitize the downloaded responses before replacing files in
   `apps/extension/src/effect/__fixtures__/`.
5. Update the Effect response schemas and rerun the validation commands.

The generated fixture script embeds the same decoded protocol configuration, so it automatically
uses the newly captured candidate order. It builds each request body and header set itself, though.
A changed endpoint, transport, or request body also needs the matching `*Fetch` function in
`apps/extension/scripts/capture-ig-fixtures.mjs` and the Endpoint column of the
[fixtures README](../apps/extension/src/effect/__fixtures__/README.md) updated, then a recapture of
that operation's fixtures, even when the response shape still decodes.

## Troubleshooting

- **The command prints usage and exits:** use `vp run update:ig-protocol --operation <operation>`.
- **No `doc_id`, `client_doc_id`, or `query_hash`:** the copied request is not a supported GraphQL operation. Capture
  the request that returns the media data for the selected request family.
- **The wrong operation was selected:** restore the JSON from Git, then rerun the updater with the
  correct explicit operation. The updater deliberately does not guess.
- **The configuration fails to load:** do not bypass the Effect Schema decoder. Correct the JSON or
  capture a compatible request.
