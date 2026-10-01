# Capturing the account Posts request and its Post node shape

Research for issue #192, under map #183 (Specify Watches and the options page). It resolves the
open items in [the #184 findings](https://github.com/zytact/GramGrab/blob/research/latest-posts-request/docs/research/latest-posts-request.md).

## Answer

instagram.com loads an account's Posts grid with a GraphQL request, not with `web_profile_info` and
not with `/api/v1/feed/user/`. Its response root is `xdt_api__v1__feed__user_timeline_graphql_connection`.
Each Post node carries everything a Watch check needs (`pk`, `code`, `media_type`, `product_type`,
`taken_at`), and the list is newest first with pinned Posts left in date order, so a Watch check can
treat page one as "the latest Posts" and diff it against the seen-set.

Two things block using it from the extension as-is:

- The page sends session tokens in the body (`fb_dtsg`, `lsd`, `jazoest`, plus `doc_id`). The
  existing GraphQL code does not obtain those. Whether the request works without them, using only
  the headers the extension already sends, was not tested.
- A page-one response is about 600 KB, and later pages 0.9 to 1.4 MB, because every node is a full
  media dict with all video and image versions.

`web_profile_info` returned HTTP 429 on the first request this session made to it, so it is not a
viable Posts source. The REST `/api/v1/feed/user/` request was not probed (see Throttling).

## Method

A dedicated Chromium (the `verify-gramgrab` browser) with the owner's Instagram login opened
`https://www.instagram.com/instagram/`, waited, and scrolled to the bottom twice, eight seconds apart.
Chrome DevTools Protocol `Network` events recorded method, path, parameter names, header names and
response status of the page's own `/api` and `/graphql` requests. Response bodies went to
`.local/raw-fixtures/posts-capture/` and stay there. No cookie, token, header value, session ID or
account ID is recorded here. The subject was the public account `instagram`.

## Candidate (b): the request instagram.com uses for the Posts grid

| Item          | Value                                                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Method, path  | `POST /graphql/query`                                                                                                        |
| Body encoding | form-encoded (`application/x-www-form-urlencoded`)                                                                           |
| First page    | friendly name `PolarisProfilePostsQuery`                                                                                     |
| Later pages   | friendly name `PolarisProfilePostsTabContentQuery_connection`                                                                |
| Keyed by      | `username` in `variables` (not the numeric user ID)                                                                          |
| Page size     | 12 (`data.count` 12 on page one, `first` 12 on later pages)                                                                  |
| Paging        | `variables.after` set to the previous `page_info.end_cursor`, with `first: 12`, `before: null`, `last: null`                |
| End of list   | `page_info.has_next_page` (still true after three pages for this account)                                                    |

Body field names: `av`, `__d`, `__user`, `__a`, `__req`, `__hs`, `dpr`, `__ccg`, `__rev`, `__s`,
`__hsi`, `__dyn`, `__csr`, `__hsdp`, `__hblp`, `__sjsp`, `__comet_req`, `fb_dtsg`, `jazoest`, `lsd`,
`__spin_r`, `__spin_b`, `__spin_t`, `__crn` (later pages), `fb_api_caller_class`,
`fb_api_req_friendly_name`, `server_timestamps`, `variables`, `doc_id`.

Header names: `Accept-Language`, `Content-Type`, `Referer`, `User-Agent`, `X-ASBD-ID`,
`X-BLOKS-VERSION-ID`, `X-CSRFToken`, `X-FB-Friendly-Name`, `X-FB-LSD`, `X-IG-App-ID`,
`X-IG-Max-Touch-Points`, `X-Root-Field-Name`, and the `sec-ch-ua*` client hints.

`variables` on page one holds `data` (`count`, `include_reel_media_seen_timestamp`,
`include_relationship_info`, `latest_besties_reel_media`, `latest_reel_media`), `username`, and three
`__relay_internal__pv__...relayprovider` flags. Later pages add `after`, `before`, `first`, `last`
and `include_multi_captions`.

This is a Relay persisted query keyed by `doc_id`, so it goes stale like the existing
`mediaByShortcode` and `reelsMedia` operations and needs a `config.json` entry plus the capture and
refresh workflow in `docs/instagram-protocol.md`.

### Response envelope

`data.xdt_api__v1__feed__user_timeline_graphql_connection` has `edges[]` and `page_info`
(`end_cursor`, `has_next_page`, `has_previous_page`, `start_cursor`). Each edge has `node` and
`cursor`. `data.xdt_viewer` sits next to it. The `__typename` of every node was `XDTMediaDict`.

### Post node fields

| Need         | Field                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------ |
| media ID     | `pk` (and `id`, same media)                                                                            |
| shortcode    | `code`                                                                                                 |
| media type   | `media_type`: 1 image, 2 video, 8 Sidecar (carousel)                                                   |
| Reel marker  | `product_type`: `clips` (Shortcode Reel, `media_type` 2), `feed` (image), `carousel_container` (Sidecar), `longform` (video) |
| Sidecar size | `carousel_media_count`, and `carousel_media` with children                                             |
| posted time  | `taken_at`, Unix seconds                                                                               |
| pinned       | `timeline_pinned_user_ids` (non-empty on a pinned Post)                                                |

All five of media ID, shortcode, media type, product type and `taken_at` were present on every one of
the 36 nodes seen across three pages. The `pk`, `code`, `taken_at` and `media_type` names match the
REST media dict the repo already decodes in `RestMediaSchema`, so a Watch schema can reuse those
field names. A node has roughly 100 other fields (caption, versions, user, counts, tracking tokens);
a Watch decoder should name only what it needs and ignore the rest.

### Pinned Posts

Across three pages, `taken_at` was strictly non-increasing. One Post on page two had
`timeline_pinned_user_ids` set, and it sat at its chronological position, not at the top. Page one
had no pinned Post. So this request does not hoist pinned Posts; a pinned old Post does not appear
first and does not look new. Detecting "new" by the seen-set of media IDs on page one is safe. This
was observed on one account with one pinned Post, so treat "never hoisted" as observed, not
guaranteed.

## Candidate (a): `web_profile_info`

`GET /api/v1/users/web_profile_info/?username=` was requested once, from the logged-in page, with the
`X-IG-App-ID` and `X-ASBD-ID` headers and `credentials: include`. It returned HTTP 429 with an HTML
body and no `Retry-After` header. The Post node shape of `edge_owner_to_timeline_media.edges` and the
`omit` versus `include` question therefore stay unanswered. The 429 on the first request of the
session is consistent with the code comment in `resolveUsernameToId` that this endpoint is the most
throttled. Do not plan Posts on it.

## Candidate: REST `/api/v1/feed/user/`

Not probed. The 429 above ended the session's active requests, as the ticket required. The grid
itself does not use it, so there is no observed evidence it exists in the current web client, and the
#184 expectation of `max_id` paging remains unverified.

## Throttling

- Page load plus two scrolls issued the Posts request three times (12 Posts each) and the page's other
  requests without any error. All returned 200.
- One extra request, `web_profile_info`, returned 429 on its first use. No further request was
  sent after it.
- The browser's own Posts requests are cheap in count (1 per 12 Posts) but heavy in bytes.

## Fixtures and the sanitizer

No fixture was committed. `apps/extension/scripts/ig-fixture-sanitizer/policy.ts` accepts a fixed set
of thirteen files, and none covers the Posts connection or a profile timeline with populated `edges`.
Its only `edge_owner_to_timeline_media` rule empties `edges` for `web-profile-info.json`. The sanitizer
fails closed on unreviewed paths, so the new response cannot be installed until a policy entry,
schema and capture-script entry are added. Hand-sanitizing was not attempted. Raw captures remain in
`.local/raw-fixtures/posts-capture/`.

## Resolved open items from #184

| #   | Item                                    | Result                                                                                               |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | User feed request path and parameters   | The grid uses `POST /graphql/query` (`PolarisProfilePostsQuery`), 12 per page, `after` cursor         |
| 2   | Shortcode Reels in the same list        | Yes, `product_type` `clips` with `media_type` 2, mixed with images and Sidecars                      |
| 3   | `web_profile_info` edges and credentials | Unanswered, request returned 429                                                                     |
| 4   | Pinned Post ordering                    | Not hoisted, appears at its date position                                                            |
| 5   | Private accounts                        | Not tested, public account only                                                                      |
| 6   | `reelsMedia` with several IDs           | Not tested                                                                                           |
| 7   | Stable Avatar URL part                  | Not tested                                                                                           |
| 8   | Throttle under repeated polling         | Not measured beyond the page's own three requests. `web_profile_info` 429s on first use              |

## Follow-ups this leaves

- Check whether the Posts GraphQL request works from the background worker without `fb_dtsg`, `lsd`
  and `jazoest`, using the same headers as the existing GraphQL calls. If not, a Watch check needs a
  different source of those tokens or the REST feed.
- Probe the REST `/api/v1/feed/user/` request once, after a cool-down.
- Add a sanitizer policy, capture entry and Effect schema for the Posts connection.
