# IG Schema Fixtures

Sanitized structural snapshots of real Instagram API responses for schema regression testing. Raw
captures are local-only sensitive data and must never be committed.

## Files

| File                     | Endpoint                                                          | What it covers                                                                                               |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `highlights.json`        | `graphql/query/?query_hash=452...` with `highlight_reel_ids`      | `ReelsMediaResponseSchema` — `GraphHighlightReel` envelope, `GraphStoryVideo` items                          |
| `story.json`             | `graphql/query/?query_hash=452...` with `reel_ids`                | `ReelsMediaResponseSchema` — `GraphReel` envelope, `GraphStoryVideo` items                                   |
| `avatar.json`            | `i.instagram.com/api/v1/users/{id}/info/`                         | `HdAvatarResponseSchema` — current empty `user` response; usable avatar URL falls back to `web_profile_info` |
| `highlights-tray.json`   | `i.instagram.com/api/v1/highlights/{id}/highlights_tray/`         | `HighlightsTrayResponseSchema` — `tray[]` listing with `cover_media`                                         |
| `web-profile-info.json`  | `api/v1/users/web_profile_info/?username=`                        | `WebProfileInfoResponseSchema` — `data.user.id` used to bridge username → user-id                            |
| `topsearch.json`         | `web/search/topsearch/?context=blended&query=`                    | `TopSearchResponseSchema` — `users[].user` exact-username fallback when `web_profile_info` is throttled      |
| `shortcode-image.json`   | `graphql/query/?doc_id=8845...` with `{ shortcode }` (image post) | `ShortcodeMediaResponseSchema` — `GraphImage` / `XDTGraphImage` branch                                       |
| `shortcode-video.json`   | `graphql/query/?doc_id=8845...` with `{ shortcode }` (video reel) | `ShortcodeMediaResponseSchema` — `GraphVideo` / `XDTGraphVideo` branch                                       |
| `shortcode-sidecar.json` | `graphql/query/?doc_id=8845...` with `{ shortcode }` (carousel)   | `ShortcodeMediaResponseSchema` — `GraphSidecar` / `XDTGraphSidecar` branch with mixed image/video children   |
| `instants-photo.json`    | `graphql/query` with the Instants client document ID              | `InstantsResponseSchema` - active photo shape and image candidates                                           |
| `instants-video.json`    | `graphql/query` with the Instants client document ID              | `InstantsResponseSchema` - video nullability, posters, duplicate progressive URLs, and DASH metadata         |
| `instants-empty.json`    | `graphql/query` with the Instants client document ID              | `InstantsResponseSchema` - successful empty active feed                                                      |

## Notes

- **CDN URLs are replaced** — signed and expiring URLs can still expose identifiers or remain usable
  temporarily. Every URL in committed fixtures uses `https://sanitized.invalid/`.
- **Timestamps are preserved** — capture, creation, taken-at, expiry, and update timestamps are
  structural regression evidence and remain unchanged.
- **Partial GraphQL errors** — every reels response includes `errors[]` for `story_cta_url` and
  `story_view_count` (fields the API refuses to serve). These are non-fatal; the extension ignores
  `errors[]` entirely (E1 posture). The fixture `errors` arrays are retained to confirm the schema
  decodes successfully in the presence of partial errors. Their `message`, `path`, severity, and
  related structural data are deliberately preserved.
- **`scans_profile` is preserved** — this is image encoding metadata, not profile identity.
- **Search social context is opaque** — `social_context` and `search_social_context` name other
  accounts ("Followed by ..."), so they are replaced rather than preserved.
- **Pseudonym numbering is batch-wide** — `SANITIZED_PERSON_N` is allocated across the whole batch,
  so adding a fixture renumbers later ones. That churn is expected and carries no new data.
- **Nulls and empty strings are preserved** — the sanitizer keeps their exact placement even on
  sensitive paths.
- **Fixture freshness** — these are snapshots in time. The schema must decode them; if a decode
  test fails after a schema change it means you broke a shape that IG was serving.

## Refreshing after Instagram changes

When `ResponseShapeUnknown` fires in the wild:

If Instagram changed the request metadata as well as the response shape, update the shared protocol
configuration first by following the
[Instagram protocol refresh guide](../../../docs/instagram-protocol.md). The generated fixture
capture script will then embed the updated configuration.

1. Copy `.env.example` to `.env`, then configure the capture values. `.env` is ignored and
   must never be committed.
2. Generate the DevTools script with `vp run generate:ig-fixtures`.
3. Paste `.local/capture-ig-fixtures.mjs` into the DevTools console on
   `https://www.instagram.com` (logged in).
4. Move exactly the twelve downloaded JSON files into `.local/raw-fixtures/`. Do not edit, publish, or
   commit this directory.
5. Run `vp run sanitize:ig-fixtures`. The complete batch must pass the reviewed path policy,
   structural invariants, and endpoint Effect Schemas before `.local/sanitized-fixtures/` changes.
6. Review the staged output. Diagnostics are value-free; inspect any newly observed raw path only
   on the local machine and follow the classification process in
   [`scripts/ig-fixture-sanitizer/README.md`](../../../scripts/ig-fixture-sanitizer/README.md).
7. Run `vp run sanitize:ig-fixtures -- --write` to transactionally replace all twelve committed JSON
   files while preserving this README and other non-fixture files.
8. Run `vp check`, `vp test run`, and `vp run fallow`. Failing fixture tests show what changed.
9. Update `src/effect/schemas.ts` when the approved response shape changed, rerun validation, and
   commit only sanitized fixtures and reviewed code or documentation changes.

The sanitizer never modifies or deletes `.local/raw-fixtures/`. Remove sensitive captures manually
when they are no longer needed. The write operation installs all twelve JSON files or rolls the
destination back; never replace individual committed fixtures from raw downloads.
