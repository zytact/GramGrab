# IG Schema Fixtures

Sanitized structural snapshots of real Instagram API responses for schema regression testing. Raw
captures are local-only sensitive data and must never be committed.

## Captured files

The capture script requests each fixture with the request values in
`src/instagram-protocol/config.json`. Shortcode media tries each `mediaByShortcode` candidate in
order and keeps the first one that answers with media.

| File                        | Endpoint                                                             | What it covers                                                                                                   |
| --------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `highlights.json`           | `api/graphql` with the `reelsMedia` document ID and `highlight:<id>` | `ReelsMediaResponseSchema` - a Highlight reel, trimmed to the fields GramGrab reads, with image and video items  |
| `story.json`                | `api/graphql` with the `reelsMedia` document ID and an account ID    | `ReelsMediaResponseSchema` - a Story reel, trimmed to the fields GramGrab reads, with image and video items      |
| `highlights-tray.json`      | `i.instagram.com/api/v1/highlights/{id}/highlights_tray/`            | `HighlightsTrayResponseSchema` - `tray[]` listing with `cover_media`                                             |
| `shortcode-image.json`      | `mediaByShortcode` with `{ shortcode }` (image post)                 | `ShortcodeMediaResponseSchema` - the image branch                                                                |
| `shortcode-video.json`      | `mediaByShortcode` with `{ shortcode }` (video reel)                 | `ShortcodeMediaResponseSchema` - the video branch                                                                |
| `shortcode-rest-video.json` | `api/v1/media/{id}/info/` (video reel)                               | `RestShortcodeResponseSchema` - captured REST video shape with only structural media fields and replacement URLs |
| `shortcode-sidecar.json`    | `mediaByShortcode` with `{ shortcode }` (carousel)                   | `ShortcodeMediaResponseSchema` - the Sidecar branch with mixed image and video children                          |
| `instants-photo.json`       | `i.instagram.com/graphql_www` with the Instants client document ID   | `InstantsFeedResponseSchema` - active photo shape and image candidates                                           |
| `instants-video.json`       | `i.instagram.com/graphql_www` with the Instants client document ID   | `InstantsFeedResponseSchema` - video nullability, posters, duplicate progressive URLs, and DASH metadata         |
| `instants-empty.json`       | `i.instagram.com/graphql_www` with the Instants client document ID   | `InstantsFeedResponseSchema` - successful empty active feed                                                      |
| `profile-posts.json`        | `api/graphql` with the `profilePosts` document ID and `fb_dtsg`      | Watch `PostsResponse` - one Posts grid page, trimmed to the fields a Watch reads, with mixed Sidecars            |

## Handwritten files

These three are written by hand, not captured. The sanitizer leaves them in place on `--write`.

| File                          | What it covers                                                                |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `instants-unknown.json`       | An Instant with an unknown `__typename` decodes and is skipped                |
| `instants-invalid-known.json` | A known Instant type with a broken shape fails as `IG_RESPONSE_SHAPE_UNKNOWN` |
| `instants-dash-only.json`     | A video Instant with only DASH sources fails as `MEDIA_DASH_ONLY_UNSUPPORTED` |

## Notes

- **CDN URLs are replaced.** Signed and expiring URLs can still expose identifiers or remain usable
  for a while. Every URL in committed fixtures uses `https://sanitized.invalid/`.
- **Timestamps are preserved.** Capture, creation, taken-at, expiry, and update timestamps are
  structural regression evidence and stay unchanged.
- **Reels are trimmed.** The capture keeps only the reel and item fields GramGrab reads, as it
  does for Posts, so the sanitizer reviews a small shape.
- **`scans_profile` is preserved.** It is image encoding metadata, not profile identity.
- **Search social context is opaque.** `social_context` and `search_social_context` name other
  accounts ("Followed by ..."), so the sanitizer replaces them.
- **Pseudonym numbering is batch-wide.** `SANITIZED_PERSON_N` is allocated across the whole batch,
  so adding a fixture renumbers later ones. That churn is expected and carries no new data.
- **Nulls and empty strings are preserved.** The sanitizer keeps their exact placement even on
  sensitive paths.
- **Fixtures are snapshots in time.** The schema must decode them. A decode test that fails after a
  schema change means the change broke a shape Instagram was serving.

## Refreshing after Instagram changes

When `ResponseShapeUnknown` fires in the wild:

If Instagram changed the request metadata as well as the response shape, update the shared protocol
configuration first by following the
[Instagram protocol refresh guide](../../../../../docs/instagram-protocol.md). The generated fixture
capture script then embeds the updated configuration.

1. Copy `.env.example` to `.env` at the repository root, then fill in the capture subjects. `.env`
   is ignored and must never be committed.
2. Generate the DevTools script with `vp run generate:ig-fixtures`.
3. Paste `.local/capture-ig-fixtures.mjs` into the DevTools console on
   `https://www.instagram.com` (logged in).
4. Move exactly the eleven downloaded JSON files into `.local/raw-fixtures/`. Do not edit, publish, or
   commit this directory.
5. Run `vp run sanitize:ig-fixtures`. The complete batch must pass the reviewed path policy,
   structural invariants, and endpoint Effect Schemas before `.local/sanitized-fixtures/` changes.
6. Review the staged output. Diagnostics are value-free. Inspect any newly observed raw path only
   on the local machine and follow the classification process in
   [`scripts/ig-fixture-sanitizer/README.md`](../../../scripts/ig-fixture-sanitizer/README.md).
7. Run `vp run sanitize:ig-fixtures -- --write` to replace the eleven captured JSON files in one
   transaction. This README and the handwritten fixtures stay as they are.
8. Run `vp check`, `vp test run`, and `vp run fallow`. Failing fixture tests show what changed.
9. Update `src/effect/schemas.ts` when the approved response shape changed, rerun validation, and
   commit only sanitized fixtures and reviewed code or documentation changes.

The sanitizer never modifies or deletes `.local/raw-fixtures/`. Remove sensitive captures by hand
when you no longer need them. The write installs all eleven captured files or rolls the
destination back. Never replace individual committed fixtures from raw downloads.
