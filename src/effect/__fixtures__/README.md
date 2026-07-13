# IG Schema Fixtures

Real Instagram API responses captured for schema regression testing.

## Files

| File                     | Endpoint                                                          | What it covers                                                                                               |
| ------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `highlights.json`        | `graphql/query/?query_hash=452...` with `highlight_reel_ids`      | `ReelsMediaResponseSchema` — `GraphHighlightReel` envelope, `GraphStoryVideo` items                          |
| `story.json`             | `graphql/query/?query_hash=452...` with `reel_ids`                | `ReelsMediaResponseSchema` — `GraphReel` envelope, `GraphStoryVideo` items                                   |
| `avatar.json`            | `i.instagram.com/api/v1/users/{id}/info/`                         | `HdAvatarResponseSchema` — current empty `user` response; usable avatar URL falls back to `web_profile_info` |
| `highlights-tray.json`   | `i.instagram.com/api/v1/highlights/{id}/highlights_tray/`         | `HighlightsTrayResponseSchema` — `tray[]` listing with `cover_media`                                         |
| `web-profile-info.json`  | `api/v1/users/web_profile_info/?username=`                        | `WebProfileInfoResponseSchema` — `data.user.id` used to bridge username → user-id                            |
| `shortcode-image.json`   | `graphql/query/?doc_id=8845...` with `{ shortcode }` (image post) | `ShortcodeMediaResponseSchema` — `GraphImage` / `XDTGraphImage` branch                                       |
| `shortcode-video.json`   | `graphql/query/?doc_id=8845...` with `{ shortcode }` (video reel) | `ShortcodeMediaResponseSchema` — `GraphVideo` / `XDTGraphVideo` branch                                       |
| `shortcode-sidecar.json` | `graphql/query/?doc_id=8845...` with `{ shortcode }` (carousel)   | `ShortcodeMediaResponseSchema` — `GraphSidecar` / `XDTGraphSidecar` branch with mixed image/video children   |

## Notes

- **Media URLs expire** — the `oe=` param in CDN URLs is a time-based expiry. Tests assert schema
  shape, not URL validity, so this is fine.
- **Partial GraphQL errors** — every reels response includes `errors[]` for `story_cta_url` and
  `story_view_count` (fields the API refuses to serve). These are non-fatal; the extension ignores
  `errors[]` entirely (E1 posture). The fixture `errors` arrays are retained to confirm the schema
  decodes successfully in the presence of partial errors.
- **Fixture freshness** — these are snapshots in time. The schema must decode them; if a decode
  test fails after a schema change it means you broke a shape that IG was serving.

## Refreshing after Instagram changes

When `ResponseShapeUnknown` fires in the wild:

1. Copy `.env.example` to `.env`, then configure the eight capture values. `.env` is ignored and
   must never be committed.
2. Generate the DevTools script with `vp run generate:ig-fixtures`.
3. Paste `.local/capture-ig-fixtures.mjs` into the DevTools console on
   `https://www.instagram.com` (logged in).
4. Download the raw Fixtures. Sanitization is a required separate step owned by open issue #44;
   no sanitizer command exists in this checkout yet.
5. Replace the matching Fixtures in this directory with only the sanitized output.
6. Run `vp test run` — failing fixture tests show what changed.
7. Update `src/effect/schemas.ts` to match the new shape, re-run validation, and commit only the
   sanitized Fixtures and schema changes.
