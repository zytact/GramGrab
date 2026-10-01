# Exact-media reacquisition for Watch actions

Research for issue #198, under map #183 (Specify Watches and the options page). It grounds the
"retain references, not bytes or signed URLs" rule from
[Define Watch actions](https://github.com/zytact/GramGrab/issues/188#issuecomment-5934861201) and
feeds the privacy amendment in #190.

## Answer

Yes for Posts, Sidecar children, Stories, and Instants, within each kind's own lifetime. No for an
Avatar that has changed again.

GramGrab already has the pattern. It resolves the item's container again with a fresh request, then
keeps only the entry whose media ID matches the recorded one, and treats zero or several matches as
a failure (`apps/extension/src/history/reconciliation.ts:14-26`,
`apps/extension/src/runner.ts:36-44`, `apps/extension/src/background.ts:1289-1298`). Signed URLs come
fresh from that response, so nothing signed has to be stored. A Watch can reuse the pattern if it
keys the container by stable IDs, matches only by media ID (never by position), and keeps
"unavailable" separate from "the request failed".

The Avatar is different. Every request GramGrab makes returns only the current Avatar, and no
request in the repo is keyed by a past picture. Once the Avatar changes again, the discovered image
is gone unless GramGrab kept its bytes or its signed URL, and #188 rules both out. The honest outcome
for that inbox entry is unavailable. Even "is the current Avatar still the discovered one?" depends
on a picture identity that #195 has not validated yet.

## Method and limits

Read: issues #183, #186, #188, #190, #192, #193, #194, #195; `CONTEXT.md`;
`docs/instagram-privacy.md`; `docs/instagram-protocol.md`; `docs/error-model.md`; the research files
on `origin/research/latest-posts-request` and `origin/research/account-posts-capture`;
`apps/extension/src/effect/` (`instagram.ts`, `schemas.ts`, fixtures);
`apps/extension/src/instagram/` (`rest-shortcode.ts`, `normalize.ts`);
`apps/extension/src/history/`; `apps/extension/src/background.ts`; `apps/extension/src/runner.ts`;
`apps/extension/src/instagram-protocol/config.json`; the fixture sanitizer.

No live Instagram request was made. Line numbers refer to `origin/main` at `61960c5`.

The committed fixtures prove field presence and nesting, nothing more. The sanitizer replaces every
ID and URL with a placeholder numbered per category, so equal raw values within one batch share a
placeholder, but a fixture cannot show an ID's format or whether two transports return the same
value for the same media (`apps/extension/scripts/ig-fixture-sanitizer/sanitize.ts:285-341`,
`README.md:80-90` in that directory). Claims marked **Unverified** need a live probe, listed at the
end.

## The existing reacquisition pattern

History redownload is exact-media reacquisition already:

1. The History entry stores the canonical Source URL (or `instants`), `itemIndex`, optional
   `mediaId`, and `mediaType`. It stores no media URL (`history/contracts.ts:14-26`).
2. Redownload resolves the Source again (`background.ts:810-823`).
3. `reconcileHistoryEntry` matches the stored `mediaId`. One match of the same media type is
   `found`, one match of another type is `missing`, several matches are `ambiguous`
   (`reconciliation.ts:18-25`).
4. `missing` becomes `MEDIA_NOT_FOUND`, or `INSTANT_NOT_ACTIVE` for Instants
   (`background.ts:834-844`). Both are item-scoped with `refetch-source` recovery
   (`docs/error-model.md:33,35`).

Two parts of it must not carry over to Watches:

- **Index fallback.** With no `mediaId`, reconciliation and the runner pick the item at the stored
  position (`reconciliation.ts:27-28`, `runner.ts:45-48`). For a Watch that is substitution: a
  deleted Sidecar child or an expired Story would quietly become whatever now sits at that index.
  A Watch reference must require a media ID, and its type should make an ID-less reference
  impossible to build.
- **Avatar identity.** `normalizeProfilePicture` sets `mediaId` to `profile-avatar:${username}`
  (`instagram/normalize.ts:101`). It names the account, not the image, so it matches whatever Avatar
  is current. A History redownload of an Avatar entry today delivers the current Avatar, which is
  exactly the substitution #188 forbids for the Watch inbox.

## Minimum reference per kind

Every reference also belongs to its Watch, which already records the creating viewer ID and the
target account ID (#186). The fields below are what one inbox entry or pending action needs on top
of that. `mediaType` is image or video, kept so a match of the wrong type reads as missing, as
History does.

| Kind          | Reference fields                                                                | Container request at action time                     | Match rule                                                                                                 |
| ------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Post          | `shortcode`, `mediaType` (image, video, or Sidecar)                             | media info by shortcode, GraphQL shortcode fallback  | REST item whose `code` equals the shortcode, as today                                                      |
| Sidecar child | parent `shortcode`, child `mediaId`, child `mediaType`, child outcome           | same request as its Post                             | exactly one child with that ID and type                                                                    |
| Story         | target user ID, Story `mediaId`, `mediaType`, `expiringAt`                       | `reelsMedia` with `reel_ids: [targetUserId]`          | exactly one item with that ID and type, in a reel owned by the target                                      |
| Instant       | target user ID, Instant `mediaId`, `mediaType`                                  | the shared Instants feed                             | exactly one item with that ID and type whose `user.id` is the target                                       |
| Avatar change | target user ID, validated picture identity (blocked on #195), observed time     | current Avatar metadata for the target               | current picture identity equals the recorded one, otherwise unavailable                                    |

Each entry also needs its discovery time for the 30-day expiry, and Posts, Stories, and Instants
need `taken_at` for the catch-up window. #186 already persists those. Nothing in the table is a URL,
a dimension, a caption, a display name, or a filename. Filenames come from the fresh response
(`filenameHint` in `normalize.ts:233,446,463,521`).

### Post

The shortcode is enough. `shortcodeMediaId` derives the numeric media ID from it
(`instagram/rest-shortcode.ts:8-13`), the media info request is keyed by that ID
(`rest-shortcode.ts:161`), and the response item must carry the same `code`
(`rest-shortcode.ts:191`). The Posts discovery node already has `pk` and `code` (#192), so a check
records both: `pk` goes in the seen-set and `code` is the reacquisition key. A Shortcode Reel is the
same case. No new request or `config.json` entry is needed.

### Sidecar child

Children are addressed by their own media ID, never by position:

- REST children require `pk` (`RestBase`, `rest-shortcode.ts:23-27`), and `decodeSidecar` returns one
  item per child with `mediaId` set to it (`rest-shortcode.ts:122-137`, `82`).
- GraphQL children decode `id` as optional (`effect/schemas.ts:26`), and the normalizer copies it
  only when present (`normalize.ts:303,318`). A child without an ID cannot be matched and must count
  as unresolvable, not fall back to its index.
- The GraphQL fixture shows every child with its own `id` and `shortcode`
  (`effect/__fixtures__/shortcode-sidecar.json:70` onward). The REST fixture is a single video with
  `carousel_media: null` (`shortcode-rest-video.json:42`), so no committed fixture shows REST child
  IDs.

For partial downloads, persist the full set of child IDs the action targeted plus one outcome per
child (#188 already requires independent child outcomes). A manual retry resolves the Post once and
acts only on children whose outcome is not accepted. A recorded child that is missing is unavailable
on its own, and its siblings are unaffected. A child in the response but not in the record is
ignored, whether it was added after discovery or was simply never recorded.

When the child set gets frozen is an open choice. If the discovery node carries child IDs, record
them at discovery. If not, freeze them at the first successful resolution, which for auto-download
happens in the same check. Whether the `PolarisProfilePostsQuery` node includes `carousel_media`
child IDs is **Unverified**: #192 reports full media dicts but no committed fixture covers that
response.

### Story

Source-wide resolution is not proof on its own. `fetchStoryMediaItems` resolves a username to an ID
and returns the account's whole active collection (`background.ts:390-411`), and
`normalizeReelsMediaItems` flattens every reel without checking its owner (`normalize.ts:212-216`).
Exactness comes from the match step:

- Request: `reelsMedia` with `reel_ids: [targetUserId]` (`background.ts:340-354`). That builder is
  already ID-keyed. A Watch must skip the username lookup, because `resolveUsernameToId` goes through
  `web_profile_info`, the endpoint that 429s (`background.ts:175-195`).
- Pick: keep the single item whose `id` equals the recorded Story ID and whose type matches. Story
  items require `id` (`schemas.ts:137,151`), and the normalizer uses it as `mediaId`
  (`normalize.ts:439,456`).
- Owner check: the reel carries `owner.id` (`schemas.ts:175-188`, `story.json:8-13`). A Watch should
  accept the item only from a reel whose owner is the target, so a stray reel in a multi-reel
  response cannot satisfy the match. Today's normalizer drops the owner, so this check needs a
  Watch-specific path.
- Expiry: items carry `expiring_at_timestamp`. In the fixture it is `taken_at_timestamp` plus 86,400
  seconds (`story.json:51`, `taken_at_timestamp` 1782920565, expiry 1783006965). Recording
  `expiringAt` lets a retry past that time report unavailable without sending a request. An earlier
  miss (the owner deleted the Story) shows up as no matching ID.

A Story that later lands in a Highlight keeps its item, but Highlights are out of scope (#183), so an
expired Story stays unavailable. Searching Highlights would be an expansion the map excludes.

Whether `/api/v1/media/{storyId}/info/` returns a single Story item is **Unverified** and not
needed: the reel request plus the ID match is already exact.

### Instant

The feed is shared, so the same rule applies. `fetchInstantsFeed` returns `items_ordered_by_time`
for everyone the viewer can see (`effect/instagram.ts:170-224`). Each item has a required `id` and a
required `user.id` (`schemas.ts:297-302,320-331`), and the normalizer uses `id` as `mediaId`
(`normalize.ts:515,537`). A Watch matches the recorded ID and also requires `user.id` to equal the
target. A miss is unavailable, which History already reports as `INSTANT_NOT_ACTIVE`
(`background.ts:836-842`).

The schema has no expiry field, so unlike Stories a retry cannot rule an Instant out without a
request. How long an Instant stays in the feed, and whether reading the feed or downloading an item
changes its visibility, is **Unverified**. If reading the feed consumes an Instant, auto-download
must act inside the discovering check and later inbox Export may never work. That needs a probe
before the inbox promises Instant Export.

### Avatar change

Two needs have to be kept apart.

**Notification icon at check time.** Supported with existing code, as long as it stays transient.
A check already sees a current Avatar URL in several responses: `profile_pic_url` on the reel owner
(`schemas.ts:179`), on the Instants user (`schemas.ts:301`), and in `web_profile_info`
(`schemas.ts:205-206`). `fetchBlobAsDataUrl` fetches such a URL with `credentials: 'omit'` and returns
a data URL in memory (`instagram.ts:226-242`). Chromium's notification API takes a data URL or blob
URL as `iconUrl` ([chrome.notifications](https://developer.chrome.com/docs/extensions/reference/api/notifications));
Firefox acceptance of a data URL is **Unverified** and belongs with the live notification checks
from #185. The bytes and URL are dropped after `notifications.create`. Nothing about this keeps an
old Avatar.

**Inbox Export later.** Possible only while the Avatar has not changed again:

- Every Avatar request returns the current image. `web_profile_info` is keyed by username and returns
  current URLs (`instagram.ts:271-284`, `background.ts:413-418`). `users/{id}/info/` is keyed by ID,
  but its committed capture is an empty `user` (`__fixtures__/avatar.json`), and `fetchHdAvatarUser`
  turns any failure into `undefined` (`instagram.ts:331-350`). No request takes a picture ID.
- Media URLs are signed and expiring (`__fixtures__/README.md:26-27`), so even a stored URL would not
  keep an old Avatar retrievable for 30 days. The only durable copy would be the bytes. Both are
  ruled out by #186 and #188.
- So inbox Export fetches the current Avatar metadata, compares its picture identity with the
  recorded one, and downloads only on an exact match. Any difference, including A to B to A when the
  identity tracks uploads, is unavailable.
- That comparison needs the validated identity from #195. Candidates exist in fixtures but are not
  decoded: `profile_pic_id` in topsearch (`topsearch.json:16`) and on the Instants user
  (`instants-photo.json:49`), but not in `web_profile_info` (`web-profile-info.json:84-85`) or the
  empty `users/{id}/info/` capture. Until #195 resolves, Avatar inbox Export cannot prove it is
  exporting the discovered image and must report unavailable rather than guess. URL equality is not
  an identity (#195).

The Avatar request is also username-keyed today. Fetching it for a stored target ID either relies on
the username verified under #194 or on `users/{id}/info/` working again.

## Unavailable, newer, or unrelated

| Situation                                      | Classification                       | Rule                                                                                             |
| ---------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Container resolves, no item with the ID        | unavailable                          | Never fall back to index, newest, or "the only item".                                            |
| Item with the ID but a different media type    | unavailable                          | As `reconcileHistoryEntry` does (`reconciliation.ts:21-23`).                                     |
| Several items with the ID                      | unresolved, not unavailable          | As History's `ambiguous` (`HISTORY_ITEM_UNRESOLVED`, `error-model.md:68`).                       |
| Story past `expiringAt`                        | unavailable, no request              | Recorded expiry is enough.                                                                       |
| Story or Instant owned by another account      | unavailable                          | Owner check on reel `owner.id` or Instant `user.id`.                                             |
| Sidecar child missing, siblings present        | that child unavailable               | Other children keep their own outcomes.                                                          |
| Sidecar has a child not in the record          | ignored                              | Not a substitute and not new media for this Watch.                                               |
| Avatar identity differs from the record        | unavailable                          | Covers a further change and A to B to A.                                                         |
| Avatar identity missing or untrusted           | unavailable for Export               | Same posture #186 takes for the check.                                                           |
| 429, network error, 5xx, auth failure          | failed, retryable                    | Not unavailable. A transient failure must not become a permanent label.                          |
| Unknown response shape                         | failed (`ResponseShapeUnknown`)      | Not unavailable.                                                                                 |

The last two rows matter because today's pipelines blur them. A REST `status: ok` with no items
returns an empty list (`rest-shortcode.ts:190`), and a GraphQL response without a node ends as an
empty list too (`background.ts:313,337`), so a deleted Post and a quietly changed response can both
look like "no items". 401 and 403 surface directly (`background.ts:329-334`), which is correct. How a
deleted, archived, or now-private Post actually answers the media info request is **Unverified**.

## Requests a Watch can use

| Kind          | Request                                                          | Code                                              | Keyed by          | Change needed for Watches                                                     |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| Post, child   | `GET /api/v1/media/{id}/info/`, then `mediaByShortcode` GraphQL   | `rest-shortcode.ts:153-194`, `background.ts:319-338` | shortcode         | none for the request; an ID-only match step                                   |
| Story         | `reelsMedia` GraphQL                                             | `background.ts:340-378`                           | target user ID    | skip username resolution, keep reel owner, match by ID                        |
| Instant       | `instantsFeed` GraphQL, needs `csrftoken`                        | `background.ts:446-478`                           | none (shared)     | owner filter by `user.id`, match by ID                                        |
| Avatar        | `web_profile_info`, `users/{id}/info/`                           | `background.ts:413-426`, `instagram.ts:331-350`   | username, user ID | decode a validated picture identity (#195), ID-keyed access (#194)            |

All of these already run from the background worker for user-requested operations, so retries and
inbox Export add no new endpoint. They add unattended or later use of these requests, which is the
change #190 has to cover.

## What the privacy amendment must permit

`docs/instagram-privacy.md` says it "does not authorize new collection, retention, or use of Instagram
data". ADR 0005 and the amended document need to name these as persisted Watch state, inside the
owner-bound, 2 MiB, versioned Watch store:

- Post shortcode and media ID. A shortcode is the path of a public Post URL, so it must stay out of
  shareable diagnostics like any literal Source URL.
- Sidecar child media IDs, child media types, and per-child action outcomes.
- Story media ID and `expiringAt`, bound to the target user ID.
- Instant media ID, bound to the target user ID.
- Avatar picture identity for each recorded change, once #195 validates one, and the observation
  time. This is separate from the "last observed Avatar identity" #186 already keeps, because inbox
  entries can outlive later changes.
- Media type, `taken_at`, and discovery time per entry.

It must also state what stays out:

- Signed media URLs, preview URLs, data URLs, blob URLs, thumbnails, and media bytes, including the
  notification Avatar. That icon is fetched with `credentials: 'omit'`, held in memory for one
  notification, and never written to storage.
- Captions, display names, and any field the match rule does not need.

It should also allow the reacquisition requests above to run on manual retry and inbox Export
without a fresh "requested operation" in the current sense. The CSRF read for Posts (#193) and any
viewer-identity read (#194) are separate allowances that #190 already tracks.

## Open follow-ups needing live probes

None of these were run. Each needs Arnab's explicit authorization for that probe, on the dedicated
`verify-gramgrab` profile, stopping at the first 429, keeping identifiers out of issues and logs.
None needs a contract amendment beyond that authorization, since each reuses an existing request
for a requested operation.

1. **Unavailable Post response.** With media you control, request
   `/api/v1/media/{id}/info/` for a deleted Post, an archived Post, and a Post on an account that went
   private. Record status code, `status`, and `items` length only. This decides whether "unavailable"
   can be told apart from a changed response shape.
2. **Instant lifetime.** Read the Instants feed twice, an hour apart, without opening any Instant,
   and record whether the same item IDs persist. Separately, check whether a background download
   changes the item's presence. This decides whether Instant inbox Export is promisable.
3. **Sidecar child IDs on discovery.** In the existing local Posts capture
   (`.local/raw-fixtures/posts-capture/`, no new request), check whether Sidecar nodes carry
   `carousel_media[].pk`. If they do, children can be frozen at discovery.
4. **ID equality across transports.** For one Sidecar, compare REST child `pk` with GraphQL child
   `id`. If they differ in format, a child recorded through one transport fails to match through
   the other. History already depends on this silently.
5. **Avatar picture identity.** Owned by #195.

## Questions this surfaces

- **Error codes for Watch unavailability.** History reuses `MEDIA_NOT_FOUND` and
  `INSTANT_NOT_ACTIVE`. Story expired and Avatar changed have no code. Decide whether Watch inbox
  reuses `MEDIA_NOT_FOUND` with a kind-specific label or adds codes under `docs/error-model.md`.
- **History redownload substitutes Avatars today.** Because of `profile-avatar:${username}`, a History
  redownload of an Avatar entry delivers the current Avatar. That is outside the Watch map but is the
  same defect class. It probably wants its own bug ticket.
- **Child set freeze point.** Record Sidecar children at discovery or at first resolution. This
  depends on follow-up 3 and belongs with the Watch store schema.
