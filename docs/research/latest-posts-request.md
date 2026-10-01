# Finding a request that lists an account's latest Posts

Research for issue #184, under map #183 (Specify Watches and the options page).

## Answer

No request GramGrab makes today lists an account's recent Posts, but one it already makes
probably carries the first page. The `web_profile_info` response that GramGrab fetches to turn a
username into a user ID has an `edge_owner_to_timeline_media` block with a total count, paging
info and an `edges` list. The committed fixture has `edges` emptied by the sanitizer, so the repo
cannot show what a Post node looks like in that list. That needs one live capture.

Two facts decide the design:

- `web_profile_info` is the endpoint the code already treats as hard-throttled. Polling it once
  per Watch per cycle is the riskiest option.
- A dedicated user-feed request (REST or GraphQL) is the likely better poll, but nothing in the
  repo or in `.repos/` describes one. Its URL, parameters and paging are unverified until someone
  captures it from a logged-in browser.

Stories, Instants and Avatar checks reuse existing requests unchanged.

## Method and limits

Sources read: `docs/instagram-protocol.md`, `docs/instagram-privacy.md`, `CONTEXT.md`,
`apps/extension/src/effect/` (`instagram.ts`, `schemas.ts`, the fixtures and their README),
`apps/extension/src/background.ts`, `apps/extension/src/instagram/rest-shortcode.ts`,
`apps/extension/src/instagram-protocol/config.json` and the fixture sanitizer policy at
`apps/extension/scripts/ig-fixture-sanitizer/policy.ts`. `.repos/` holds only `effect`, so no
vendored Instagram client exists to read.

No live Instagram request was made. Anything below marked **Unverified** comes from general
knowledge of how the Instagram web client behaves, not from a source in this repo, and needs a
live capture before it goes into a spec.

## What GramGrab already requests

| Request                                                                | Used for                             | Carries                                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/users/web_profile_info/?username=`                        | username to user ID, avatar fallback | user `id`, `profile_pic_url_hd`, counts, and the `edge_owner_to_timeline_media` block                      |
| `GET /web/search/topsearch/?context=blended&query=`                    | username to user ID when throttled   | `users[].user.pk`, exact-username match only                                                               |
| `GET /api/v1/media/{id}/info/`                                         | one Post or Shortcode Reel           | `pk`, `code` (shortcode), `taken_at`, `media_type` 1/2/8, versions                                         |
| `mediaByShortcode` GraphQL                                             | fallback for the above               | `shortcode`, `id`, `taken_at_timestamp`, `__typename`, `is_video`, `product_type`                          |
| `reelsMedia` GraphQL, `reel_ids: [userId]`                             | Stories (and Highlights by their ID) | per reel `latest_reel_media`; per item `id`, `taken_at_timestamp`, `expiring_at_timestamp`, `__typename`   |
| `instantsFeed` GraphQL (`client_doc_id`, needs the `csrftoken` cookie) | active Instants, whole shared feed   | `items_ordered_by_time[]` with `id`, `taken_at`, `media_type`, and `user.id`                               |
| `GET i.instagram.com/api/v1/users/{id}/info/`                          | HD Avatar                            | `hd_profile_pic_url_info`; the committed fixture is an empty `user`, so `web_profile_info` is the fallback |
| `GET i.instagram.com/api/v1/highlights/{id}/highlights_tray/`          | Highlight covers                     | not needed for Watches (Highlights are out of scope)                                                       |

Sources: `fetchWebProfileInfoUser`, `fetchTopSearchUserId`, `fetchReelsMedia`, `fetchInstantsFeed`,
`fetchHdAvatarUser`, `fetchHighlightsTray` in `apps/extension/src/effect/instagram.ts`;
`fetchRestShortcodeRaw` in `apps/extension/src/instagram/rest-shortcode.ts`; schemas in
`apps/extension/src/effect/schemas.ts`.

## Candidates for listing latest Posts

### A. `web_profile_info` first page (evidence in repo)

- The sanitizer policy preserves `data.user.edge_owner_to_timeline_media.count` and
  `page_info.has_next_page`, replaces `page_info.end_cursor` with an opaque token, and forces
  `edges` to an empty array (`policy.ts`, `profileRules` and the `web-profile-info.json` entry).
  A policy that has to empty `edges` implies the raw response had entries.
- The committed fixture shows `has_next_page: true`, an empty cursor placeholder and `edges: []`.
- `WebProfileInfoUserSchema` in `schemas.ts` decodes only `id`, `pk` and the profile picture
  fields. It ignores the timeline block, so no schema exists for it.
- Cost: 1 request returns the user ID, the Avatar URL and the first page of Posts together.
- Weakness 1: `resolveUsernameToId` in `background.ts` says Instagram throttles `web_profile_info`
  "hard enough to 429 an ordinary signed-in session" and falls back to topsearch. Topsearch
  returns no Posts, so a throttled poll yields nothing.
- Weakness 2: `fetchProfileMediaItems` calls it with `credentials: 'omit'`, while
  `resolveUsernameToId` uses `'include'`. Whether the timeline block is the same for both, and for
  private accounts the viewer follows, is not in the repo.
- Weakness 3: the `end_cursor` here is built for a different paging request, not for this one.
  Paging past the first page needs candidate B or C.

### B. User feed REST request (Unverified)

The Instagram web client is known to read a profile grid from a REST feed endpoint under
`/api/v1/feed/user/`, keyed by user ID or by username, with a `count` parameter and paging through
a `max_id` / `next_max_id` pair plus a `more_available` flag. Response items are the same media
dict GramGrab already decodes from `/api/v1/media/{id}/info/`. In the repo, `RestMediaSchema` in
`rest-shortcode.ts` already decodes `pk`, `code`, `taken_at` and `media_type` (1 image, 2 video,
8 sidecar), which are exactly the fields a Watch check needs.

If a capture confirms this, a Watch check is one call per account with the cached user ID, a
decoder that reuses the REST media schema, and the same auth headers as `fetchRestShortcodeRaw`
(`X-IG-App-ID`, `X-ASBD-ID`, `credentials: 'include'`). The endpoint would be hardcoded like the
media-info endpoint, with no `config.json` entry. Open items: exact path and parameters, default
page size, whether Shortcode Reels appear in this list, how pinned Posts are ordered, and the
private-account behavior.

### C. Profile posts GraphQL query (Unverified)

The web client also loads the profile grid through a GraphQL `doc_id` operation, with a cursor in
the variables and `page_info` in the response. Using it means a new operation key in
`config.json` (for example `profilePosts`), a row in the operation table of
`docs/instagram-protocol.md`, a fixture and a sanitizer entry, because a `doc_id` goes stale and
needs the capture-and-update workflow. REST (candidate B) avoids that upkeep.

### Recommendation

Capture B and C live and pick B if it returns `pk`, `code`, `taken_at` and `media_type` per item.
Keep A only as the source of the user ID and Avatar URL. Whichever is chosen, the Watch should
cache the numeric user ID so a normal check does not resolve the username again.

## Fields a Watch check needs

| Need        | `web_profile_info` edges (A)      | User feed REST (B, Unverified) | Source in repo for the field name                                          |
| ----------- | --------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| media ID    | not confirmed, node shape unknown | `pk`                           | `pk` in `RestBase`; `id` in the GraphQL shortcode node                     |
| shortcode   | not confirmed                     | `code`                         | `code` in `RestBase`; `shortcode` in the GraphQL fixtures                  |
| media type  | not confirmed                     | `media_type` 1, 2, 8           | `RestMediaSchema`; `__typename` and `is_video` in the GraphQL fixtures     |
| posted time | not confirmed                     | `taken_at` (seconds)           | `RestBase`; `taken_at_timestamp` in the GraphQL fixtures                   |

Shortcode Reel detection: the GraphQL shortcode node has `product_type` and `is_video`, and the
REST shape has `media_type` 2. Whether a feed or grid item marks a Shortcode Reel (for example with
a product type of `clips`) is **Unverified**.

## Paging

- Candidate A: first page only. The page size is not recorded in the repo. `has_next_page` and
  `end_cursor` exist but belong to another request.
- Candidates B and C: cursor paging is expected (`max_id` / `next_max_id` or `end_cursor`).
- Because each Watch keeps a seen-set of media IDs, a check only needs the first page. Stop as
  soon as a page contains an ID already in the seen-set, and fetch the next page only when every
  ID on a page is new. Do not compare `taken_at` against the last check, because pinned Posts can
  appear first out of date order (**Unverified**).
- The first check records a baseline from page one and acts on nothing, so no deep paging occurs
  there either.

## Reuse by the other media kinds

All three reuse existing request code with no change to request shape, schemas or `config.json`.

- **Stories.** `reelsMedia` with `createReelsRequestVariables('story', userId)` in `background.ts`.
  Items carry `id` and `taken_at_timestamp`, and the reel carries `latest_reel_media`. Needs the
  numeric user ID. Whether one call accepts several user IDs in `reel_ids` is **Unverified**; every
  existing call sends one.
- **Instants.** `fetchInstantsFeed` returns the whole shared feed in one request. Each item has
  `user.id` and `user.username`, so a check filters by the Watch's user ID. One call per cycle
  serves every Watch that includes Instants. It needs the `csrftoken` cookie that the Instants
  path already reads under the existing `cookies` permission.
- **Avatar.** The `profile_pic_url_hd` in `web_profile_info` is the only dependable source, since
  `users/{id}/info/` currently returns an empty `user`. CDN URLs are signed and expiring (see the
  fixtures README), so change detection needs a stable key such as the path part of the URL
  without its signature. Which part is stable is **Unverified**.

## Cost of one Watch check, in requests

Assuming the user ID is cached on the Watch, so username resolution is a one-time cost at Watch
creation (1 request, 2 if `web_profile_info` is throttled and topsearch runs).

| Media kind | Requests per check | Notes                                                             |
| ---------- | ------------------ | ----------------------------------------------------------------- |
| Posts      | 1 (B or C)         | 1 more per extra page only when a whole page is unseen            |
| Stories    | 1                  | `reelsMedia`; the fallback candidate adds 1 only on failure       |
| Instants   | 1 shared per cycle | Same call for every Watch with Instants, so N Watches cost 1      |
| Avatar     | 1                  | `web_profile_info`; skip `users/{id}/info/`, its fixture is empty |

A Watch covering all four kinds costs 3 requests plus its share of the Instants call. If Posts
come from `web_profile_info` (A), Posts and Avatar share one response, so the same Watch costs 2
requests plus the Instants share, at the price of leaning on the throttled endpoint. Existing
retry and `RateLimited` handling in `instagram.ts` apply unchanged.

## Open items needing a live capture

1. The user feed request: path, parameters, default and maximum page size, and response envelope.
2. Whether Shortcode Reels appear in the same list as Posts, and how they are marked.
3. Node shape of `edge_owner_to_timeline_media.edges` in `web_profile_info`, and whether the
   `omit` and `include` credential modes return the same block.
4. Pinned Post ordering in the list.
5. Behavior for private accounts the viewer follows, and for accounts the viewer cannot see.
6. Whether `reelsMedia` accepts several user IDs in one call.
7. Which part of the Avatar URL stays stable when the image does not change.
8. The throttle behavior of the chosen request under repeated polling across several Watches.

Capture follows `docs/instagram-protocol.md` and `docs/instagram-privacy.md`: a Copy-as-fetch
request goes to stdin only, and raw responses stay in `.local/raw-fixtures/`. Any new response
shape needs a sanitized fixture and an Effect schema before it ships. ADR 0005 should record the
persisted seen-set of media IDs, which is new retained Instagram data under the privacy contract.
