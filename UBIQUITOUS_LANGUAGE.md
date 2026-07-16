# Ubiquitous Language

## Media kinds

| Term          | Definition                                                                               | Aliases to avoid         |
| ------------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| **Post**      | A permanent Instagram shortcode-addressable media item (image, video, or sidecar)        | Feed item                |
| **Reel**      | A short-form video served via the shortcode endpoint, distinct from a **Story** **Reel** | Clip                     |
| **Sidecar**   | A multi-item **Post** carrying multiple image/video children under one shortcode         | Album, carousel, gallery |
| **Story**     | An ephemeral item belonging to a user's current 24-hour tray                             | Snap                     |
| **Highlight** | A curated, persistent collection of past **Stories** grouped under a tray entry          | Saved story              |
| **Avatar**    | A user's profile picture, available in standard and HD variants                          | Profile pic, DP          |

## Schema & decoding

| Term                      | Definition                                                                                                          | Aliases to avoid      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------- |
| **Schema**                | An Effect `Schema` describing the expected shape of an Instagram API response                                       | Type, validator       |
| **Tagged union**          | A `Schema.Union` discriminated by the IG `__typename` field                                                         | Sum type, variant     |
| **Typename**              | The `__typename` string IG attaches to a node, used as the discriminator                                            | Kind, tag             |
| **Decode**                | Running `Schema.decodeUnknown` against a raw JSON payload to produce a typed value                                  | Parse, validate       |
| **Unknown passthrough**   | A fallback union member that accepts unrecognised `__typename` values so partial IG changes don't fail the response | Catch-all, fallback   |
| **Strict + loud posture** | The project rule that decode failures must surface as `ResponseShapeUnknown`, never silent casts                    | Lenient parsing       |
| **Fixture**               | A captured real IG API response stored under `src/effect/__fixtures__/` and exercised by fixture tests              | Sample, mock response |
| **Normalizer**            | Code that walks a decoded schema value and produces the app's internal media list, skipping Unknown nodes           | Mapper, transformer   |

## Errors

| Term                       | Definition                                                                                         | Aliases to avoid |
| -------------------------- | -------------------------------------------------------------------------------------------------- | ---------------- |
| **`ResponseShapeUnknown`** | Tagged error raised when a response fails schema decoding                                          | Parse error      |
| **`RateLimited`**          | Tagged error raised on HTTP 429 from IG                                                            | Throttled        |
| **`NetworkError`**         | Tagged error wrapping a failed `fetch` (DNS, offline, abort, etc.)                                 | Fetch error      |
| **`HttpError`**            | Tagged error for non-OK HTTP responses other than 429                                              | Status error     |
| **`GraphQLRequestFailed`** | Tagged error for IG GraphQL-layer failures (operation rejected, missing data wrapper)              | GQL error        |
| **Failure code**           | Stable symbolic identifier for a user-operation failure, defined by the canonical error registry   | Error message    |
| **Recovery action**        | Closed action identifier derived from failure policy, such as retry, refetch, or original fallback | Button text      |
| **Operation outcome**      | Honest state of one logical item: pending, started, failed, skipped, or not attempted              | Result string    |
| **Operation ID**           | Stable identity of one logical selected item across retries and fallbacks                          | Request ID       |
| **Request ID**             | Fresh correlation identity for one transport execution                                             | Operation ID     |

## Endpoints

| Term                   | Definition                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| **Shortcode media**    | The GraphQL endpoint returning a **Post**, **Reel**, or **Sidecar** keyed by shortcode                |
| **`reels_media`**      | The GraphQL endpoint returning a user's **Stories** and **Highlight** items as `ReelItem[]`           |
| **`web_profile_info`** | The web endpoint returning standard-resolution **Avatar** and basic profile info                      |
| **HD avatar endpoint** | `i.instagram.com/api/v1/users/{id}/info/` — returns the HD **Avatar** variants, no `data` wrapper     |
| **`highlights_tray`**  | `i.instagram.com/api/v1/highlights/{id}/highlights_tray/` — lists a user's **Highlight** tray entries |

## Relationships

- A **Post** has exactly one **Typename** that selects one branch of the shortcode **Tagged union** (Video, Image, **Sidecar**, or Unknown).
- A **Sidecar** contains many child nodes, each of which is decoded as an image or video by runtime `is_video` inspection.
- A **Reel** (the **Story** tray sense) contains many **Story** items; each item is itself a **Tagged union** of video, image, or Unknown.
- A **Highlight** is fetched as a tray entry first, then resolved to **Story**-shaped items via `reels_media`.
- Every endpoint response is **Decode**-ed through exactly one top-level **Schema**; failure produces a **`ResponseShapeUnknown`**.

## Example dialogue

> **Dev:** "If IG renames `XDTGraphSidecar` to something new, does the whole **Post** fail to **Decode**?"
> **Domain expert:** "No — the **Sidecar** branch of the **Tagged union** would miss, but the **Unknown passthrough** catches it, so the **Schema** decode succeeds. The **Normalizer** then skips that node and the user sees an empty media list rather than a `ResponseShapeUnknown`."
> **Dev:** "And if the outer `data` wrapper itself disappears?"
> **Domain expert:** "Then there's no Unknown branch to absorb it — `Schema.decodeUnknown` fails at the top level and we raise `ResponseShapeUnknown`. That's the **strict + loud posture**: structural changes are loud, vocabulary changes are quiet."
> **Dev:** "So to repair it I capture a fresh **Fixture** and update the **Schema**?"
> **Domain expert:** "Exactly — `scripts/capture-ig-fixtures.mjs` in DevTools, drop the JSON into `src/effect/__fixtures__/`, then update `schemas.ts` until the fixture test passes."

## Flagged ambiguities

- **"Reel"** is overloaded. In the shortcode endpoint it means a short-form video **Post**; in `reels_media` it means a container of **Story** items (a user's 24-hour tray). When ambiguous, qualify as **"shortcode Reel"** or **"Story Reel"**.
- **"Story"** vs **"Highlight"** — a **Story** is ephemeral (24-hour), a **Highlight** is a curated persistent collection of past **Stories**. Both decode to the same `StoryItem` shape, but their lifecycles differ.
- **"Unknown"** is used in two senses: the schema-level **Unknown passthrough** branch (intentional, silent) and the error `ResponseShapeUnknown` (top-level decode failure, loud). They are opposites, not synonyms.
- **"Avatar"** has two endpoints with incompatible shapes: `web_profile_info` wraps in `data.user`, the HD endpoint returns `{ user, status }` with no `data` wrapper. Use the explicit endpoint name when discussing the response shape.
