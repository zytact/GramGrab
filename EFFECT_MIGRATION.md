# Effect.ts Migration

> **Current phase:** Phase 5 complete — `ShortcodeMediaResponseSchema` + `ShortcodeNodeSchema` in `src/effect/schemas.ts`; `graphqlFetch` Effect in `src/effect/instagram.ts`; `resolveMediaEffect` + `downloadMediaEffect` in `src/background.ts` dedupe `handleFetchMedia`/`executeDownload`; `normalizeShortcodeMedia` accepts typed `ShortcodeNode`; `walkObjects` shortcode fallback removed; 83 tests green.
> **Next step:** Phase 6 — Retry/backoff (`Effect.retry` on `GraphQLRequestFailed`/`RateLimited`), concurrency (`Effect.forEach` with bounded N), partial-success accumulation for batch downloads.

---

## 1. Current Architecture

All business logic lives in four source files. There are no content scripts.

### `src/background.ts` (745 lines) — the primary migration target

The MV3 service worker. Mixes URL parsing, Instagram network calls, untyped JSON
normalization, and `chrome.downloads` side effects in a single file. Public
interface is a `chrome.runtime.onMessage` dispatcher at line 652.

| Symbol | Lines | Kind | Notes |
|---|---|---|---|
| `parseInstagramUrl` | 36–85 | pure | `try/catch` → `null`; handles post/reel/story/highlight/profile |
| `resolveUsernameToId` | 87–98 | `fetch` | `credentials:'include'`; `!ok` → `null` (no status distinction) |
| `graphqlFetch` | 100–115 | `fetch` | `credentials:'include'`; `!ok` → `throw new Error("GraphQL failed: ${status}")` |
| `fetchProfilePicture` | 227–267 | `fetch` ×2 | step 1 `credentials:'omit'` throws; step 2 `credentials:'include'` swallowed |
| `extractMediaUrls` | 124–134 | pure | extracts `displayUrl/videoUrl/videoResources` from `Record<string,unknown>` |
| `unwrapData` | 136–139 | pure | strips outer `{data:{…}}` wrapper |
| `walkObjects` | 141–163 | pure | iterative DFS collecting all objects (cycle-safe); exists because IG shapes drift |
| `findArrayCandidates` | 165–186 | pure | same DFS collecting all arrays |
| `normalizeShortcodeMedia` | 280–398 | pure | handles post/reel; `__typename` branching, sidecar children, display_resources |
| `normalizeReelsMedia` | 400–454 | pure | handles story/highlight; heuristic `findArrayCandidates` fallback |
| `normalizeProfilePicture` | 198–225 | pure | merges `web_profile_info` + optional HD-pic URL |
| `pickBestVideoResource` | 117–122 | pure | max `config_width` sort |
| `pickPreviewSrc` | 269–278 | pure | min ≥320px sort |
| `handleDownload` | 466–472 | handler | `.then/.catch` → `{ media, error }` |
| `handleFetchMedia` | 479–527 | handler | `try/catch` → `{ media, error }` |
| `handleGetPreviewUrl` | 534–548 | handler | `fetch` CDN → `blobToDataUrl` → `{ previewUrl, error }` |
| `handleDownloadMedia` | 562–577 | handler | sequential `for await browser.downloads.download` loop |
| `handleFetchVideoBlob` | 579–593 | handler | `fetch` CDN → `blobToDataUrl` → `{ dataUrl, error }` (near-identical to above) |
| `handleDebugShape` | 600–613 | handler | `graphqlFetch` → raw JSON |
| `handleDownloadDebugJson` | 620–639 | handler | `jsonToDataUrl` → `browser.downloads.download` |
| `executeDownload` | 693–745 | orchestrator | **duplicates** `handleFetchMedia` dispatch; sequential download loop |
| dispatcher | 652–687 | top-level | `switch(msg.type)` → `handler().then(sendResponse); return true` |

Key issues for migration:
- All errors collapse to `String(err)` — 401/403/429/private/not-found are indistinguishable.
- `handleFetchMedia` and `executeDownload` duplicate the fetch+normalize dispatch logic.
- Sequential download loops (`:565`, `:736`) are fail-fast; partial success is lost.
- No retry, backoff, or concurrency control anywhere.

### `src/lib/browser.ts` — the I/O seam

Proxy-based shim that resolves `globalThis.browser` → `globalThis.chrome` wrapper
→ no-op stub. Promisifies `chrome.*` callback APIs (tabs.query, downloads.download,
storage.get/set, runtime.sendMessage). The Proxy re-reads `globalThis` on every
property access, which is why per-test global reassignment works in tests.

APIs wrapped: `runtime.sendMessage`, `runtime.onMessage.addListener`, `tabs.query`,
`downloads.download`, `storage.local.get/set`.

### `src/lib/data-url.ts` — SW-safe blob encoding

`blobToDataUrl(blob): Promise<string>` — chunked `arrayBuffer` → `btoa`; avoids
`FileReader` (unavailable in MV3 worker) and `URL.createObjectURL`.
`jsonToDataUrl(value): string` — UTF-8 → latin1 → base64 data: URL.

### `src/popup.tsx` — React UI (stay mostly plain TS)

React state machine (`idle | fetching | downloading | done | error`). Sends messages
to background via `browser.runtime.sendMessage`. Contains:

- `captureFrameFromVideo` (`:147`) — `loadedmetadata` → seek → canvas drawImage →
  `toBlob`. Uses **untimed** event promises (`loadedmetadata`/`seeked`): if either
  event never fires the promise hangs forever.
- `handleExportFrame` (`:188`) — sends `FETCH_VIDEO_BLOB` to background (avoids
  CORS-tainted canvas), then calls `captureFrameFromVideo`.

The frame-extraction hang is the strongest Effect/timeout candidate in popup code,
but it is UI-context (needs DOM). Deferred to Phase 7+.

---

## 2. Migration Boundaries

### Stay plain TypeScript

- `src/popup.tsx` — React state, event handlers, rendering. Keep unchanged unless
  a tiny seam change is required to consume Effect output.
- `src/lib/browser.ts` — the shim internals. Will eventually grow an Effect layer
  *on top of* it, not replacing the Proxy mechanism.
- Pure helpers in `background.ts`: `parseInstagramUrl`, `walkObjects`,
  `findArrayCandidates`, `pickBestVideoResource`, `pickPreviewSrc`,
  `extractMediaUrls`, `unwrapData` — pure functions, no I/O; no Effect needed.
- `scripts/postbuild.mjs`, `vite.config.ts`, `tsconfig.json` — build tooling; untouched.

### Migrate to Effect (incrementally)

The network + orchestration core of `background.ts`:
- `graphqlFetch`, `resolveUsernameToId`, `fetchProfilePicture`
- `handleGetPreviewUrl`, `handleFetchVideoBlob` (the CDN fetch→dataUrl path)
- `handleDownloadMedia`, `executeDownload` (the download pipelines)
- Eventually: `handleFetchMedia` + dedupe with `executeDownload`

### Public seam stays Promise-shaped

Each `handleX` keeps its `async (msg) => Promise<{ ..., error: string|undefined }>`
signature. Internally it runs an Effect program:

```ts
// before
async function handleFetchVideoBlob(msg) {
  try { ... } catch (err) { return { dataUrl: undefined, error: String(err) }; }
}

// after (Phase 3+)
async function handleFetchVideoBlob(msg) {
  return Effect.runPromise(fetchBlobProgram(msg.url).pipe(
    Effect.map(dataUrl => ({ dataUrl, error: undefined })),
    Effect.catchAll(err => Effect.succeed({ dataUrl: undefined, error: formatError(err) }))
  ));
}
```

The dispatcher (`:652`) and the popup are **unchanged**.

---

## 3. Candidate Effect Domains

Mapped to real code locations:

| Domain | Code location | What Effect adds |
|---|---|---|
| Fetch wrappers | `graphqlFetch:100`, `resolveUsernameToId:87`, `fetchProfilePicture:227` | `Effect.tryPromise` + typed `NetworkError`/`HttpError` instead of implicit throw |
| HTTP status → typed error | all `!res.ok` checks | distinguish 401/403/429 → `NotAuthenticated`/`Forbidden`/`RateLimited` |
| CDN fetch→dataUrl | `handleGetPreviewUrl:534`, `handleFetchVideoBlob:579` | dedupe identical logic; typed errors; `Effect.runPromise` at seam |
| JSON response parsing | normalizers `:198,:280,:400`; `unwrapData:136` | `effect/Schema` decodes happy-path; `ResponseShapeUnknown` on mismatch |
| Media resolution branching | `handleFetchMedia:489`, `executeDownload:699` | explicit `Effect.flatMap` chain; dedupe the duplicated dispatch |
| Download pipeline | `handleDownloadMedia:565`, `executeDownload:736` | `Effect.forEach` with bounded concurrency; per-item `Either` for partial success |
| Retry/backoff | absent | greenfield `Effect.retry` on `GraphQLRequestFailed`/`RateLimited` |
| Timeouts/interruption | `captureFrameFromVideo:147` (hanging event promises) | `Effect.timeout` on `loadedmetadata`/`seeked` — Phase 7+ |
| Progress | absent | greenfield — terminal-state only today |
| Browser API wrappers | `browser.downloads.download:571`, `browser.tabs.query` (popup) | `BrowserService` with typed `BrowserDownloadFailed` |

---

## 4. Domain Error Model

Tagged errors using `Data.TaggedError`. Only errors the actual code produces or
can meaningfully distinguish are included.

```ts
// src/effect/errors.ts

import { Data } from 'effect';

// URL parsing
export class InvalidInstagramUrl extends Data.TaggedError('InvalidInstagramUrl')<{ url: string }> {}

// Username resolution
export class UsernameUnresolved extends Data.TaggedError('UsernameUnresolved')<{ username: string }> {}

// Network / HTTP
export class NetworkError extends Data.TaggedError('NetworkError')<{ cause: unknown }> {}
export class HttpError extends Data.TaggedError('HttpError')<{ status: number; message: string }> {}

// These derive from HttpError.status — new behavior enrichment (Phase 3+)
export class NotAuthenticated extends Data.TaggedError('NotAuthenticated')<{ status: 401 }> {}
export class Forbidden extends Data.TaggedError('Forbidden')<{ status: 403 }> {}
export class RateLimited extends Data.TaggedError('RateLimited')<{ status: 429 }> {}

// GraphQL path
export class GraphQLRequestFailed extends Data.TaggedError('GraphQLRequestFailed')<{ status: number }> {}

// Media normalization
export class MediaNotFound extends Data.TaggedError('MediaNotFound')<{ hint: string }> {}
export class ResponseShapeUnknown extends Data.TaggedError('ResponseShapeUnknown')<{ context: string }> {}

// Downloads
export class BrowserDownloadFailed extends Data.TaggedError('BrowserDownloadFailed')<{ url: string; cause: unknown }> {}

// Frame extraction (Phase 7+)
export class VideoFrameExtractionFailed extends Data.TaggedError('VideoFrameExtractionFailed')<{ reason: 'no-duration' | 'no-frame' | 'no-canvas' | 'no-blob' | 'cors' | 'timeout' }> {}
```

**Not included** (no distinguishing evidence in current code): `StoryExpired`,
`PrivateAccountNotAccessible` as a distinct type — these collapse into `Forbidden`
or `MediaNotFound` until the code inspects the actual Instagram error payload.

---

## 5. Schema / Validation Plan

External JSON boundaries to decode with `effect/Schema`, in priority order:

### Priority 1 — `web_profile_info` user object
Used by `resolveUsernameToId` (:93) and `fetchProfilePicture` (:236).

```ts
const WebProfileInfoUser = Schema.Struct({
  id: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  pk: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  profile_pic_url_hd: Schema.optional(Schema.String),
  profile_pic_url: Schema.optional(Schema.String),
  profile_pic_dimensions: Schema.optional(Schema.Struct({
    width: Schema.optional(Schema.Number),
    height: Schema.optional(Schema.Number),
  })),
});
const WebProfileInfoResponse = Schema.Struct({
  data: Schema.optional(Schema.Struct({ user: Schema.optional(WebProfileInfoUser) })),
});
```

### Priority 2 — shortcode GraphQL response
Used by `normalizeShortcodeMedia` (:280). The `xdt_shortcode_media` /
`shortcode_media` / `media` fields with `edge_sidecar_to_children`. The
`walkObjects` fallback is kept as an explicit branch that returns
`ResponseShapeUnknown` if Schema decode fails — shape drift becomes a typed,
logged failure rather than a silent empty result.

### Priority 3 — reels GraphQL response
Used by `normalizeReelsMedia` (:400). The `reels_media[].items[]` array.
Same strategy: Schema for happy path, `findArrayCandidates` fallback → `ResponseShapeUnknown`.

**Goal:** replace unsafe deep `as Type` casts with explicit decode failures so
Instagram API shape changes surface as typed errors rather than runtime crashes.

---

## 6. Service / Dependency Model

Candidates with rationale — not created up front, introduced per phase:

| Service | Wraps | Phase | Rationale |
|---|---|---|---|
| `InstagramClient` | `graphqlFetch`, `resolveUsernameToId`, `fetchProfilePicture` | 5 | Central, testable, injectable. Replaces three scattered fetch functions. |
| `DownloadService` | `browser.downloads.download` | 5–6 | Enables concurrency control, typed `BrowserDownloadFailed`, test injection. |
| `Logger` | `Console` (Effect built-in) | 1 | Cheap. Replaces absent/scattered `console.log`; makes what's logged explicit. |
| `BrowserRuntimeService` | `browser.runtime.sendMessage` + `browser.tabs.query` | 7+ | Only needed if popup is ever migrated; `storage` is dead. Defer. |
| `FrameExtractionService` | `captureFrameFromVideo` | 7+ | UI-context; needs DOM. Defer. |
| `ProgressService` | — | 7+ | No progress channel exists today; would require popup message-shape change. Defer. |

---

## 7. Incremental Migration Phases

Each phase is independently reviewable and **preserves observable behavior**.

### Phase 0 — Architecture documentation ✅
This document. No code changes.

### Phase 1 — Add Effect, scaffold conventions
```
bun add effect
```
- Create `src/effect/errors.ts` (all tagged errors as defined above — unused yet).
- Create `src/effect/runtime.ts` (a thin `Effect.runPromise` re-export + the
  `runHandler` helper that maps Effect failures to `{ ..., error: string }`).
- No existing call sites changed.
- Verify: `bun run typecheck`, `bun run lint`, `bun run test` all green.

**Note on import extensions**: use `.ts` extensions in `import` statements
within `src/effect/` and when importing from `src/effect/` (e.g.
`import { ... } from './errors.ts'`). `allowImportingTsExtensions: true`
permits this. Legacy `src/` files remain extensionless.

### Phase 2 — Error types + Promise-boundary helper
- Finalize `src/effect/errors.ts` with the `formatError(err: unknown): string`
  function that serializes tagged errors to human-readable strings for the
  existing `{ error: string }` response shape.
- Wire `runHandler` into one handler as a proof-of-concept (no behavior change —
  the Effect program just wraps the same logic).
- Tests still green.

### Phase 3 — Migrate fetch→dataUrl (first real migration)

Target: `handleFetchVideoBlob` (:579) and `handleGetPreviewUrl` (:534).
These are nearly identical and self-contained.

```ts
// new: src/effect/instagram.ts
const fetchBlobAsDataUrl = (url: string) =>
  Effect.gen(function* () {
    const res = yield* Effect.tryPromise({
      try: () => fetch(url, { credentials: 'omit' }),
      catch: cause => new NetworkError({ cause }),
    });
    if (!res.ok) yield* Effect.fail(new HttpError({ status: res.status, message: res.statusText }));
    const blob = yield* Effect.tryPromise({
      try: () => res.blob(),
      catch: cause => new NetworkError({ cause }),
    });
    return yield* Effect.tryPromise({
      try: () => blobToDataUrl(blob),
      catch: cause => new NetworkError({ cause }),
    });
  });
```

`handleFetchVideoBlob` and `handleGetPreviewUrl` both become one-liners calling
`fetchBlobAsDataUrl` via `runHandler`. The exact `{ dataUrl, error }` /
`{ previewUrl, error }` shape is preserved.

Existing tests: `background.test.ts` covers GET_PREVIEW_URL 403 + success path +
no-FileReader — these guard the behavior.

### Phase 4 — Schema validation for web_profile_info
- Add the `WebProfileInfoResponse` Schema to `src/effect/schemas.ts`.
- `resolveUsernameToId` uses `Schema.decodeUnknown` instead of the cast at `:93`.
- On schema failure → `ResponseShapeUnknown` (logged; treated as "user not found"
  for now to preserve behavior).
- `fetchProfilePicture` uses the same schema.

### Phase 5 — Migrate one full workflow end-to-end (post/reel)

- Add shortcode GraphQL Schema.
- Migrate `graphqlFetch` to return `Effect<Record<string,unknown>, GraphQLRequestFailed | NetworkError>`.
- Migrate `normalizeShortcodeMedia` to use Schema.decodeUnknown; keep tree-walk
  fallback branch → `ResponseShapeUnknown`.
- **Dedupe** `handleFetchMedia` and `executeDownload` by extracting shared
  `fetchAndNormalize(parsed)` Effect.
- All existing tests still green.

### Phase 6 — Retry, concurrency, partial-success

- Add `Effect.retry` with exponential backoff on `GraphQLRequestFailed` and
  `RateLimited` (Phase 3 begins distinguishing 429).
- Replace sequential download `for` loops with `Effect.forEach(..., { concurrency: N })`
  where N is configurable (default 3). Per-item `Either` → partial success
  accumulation instead of fail-fast.
- This is behavior *enrichment*, not a behavior-preserving migration — needs
  review of the popup message shape if partial success is surfaced.

### Phase 7 — Remaining workflows + optional popup enhancements

- Migrate story/highlight/profile workflows.
- `captureFrameFromVideo` with `Effect.timeout` on event promises.
-  `BrowserRuntimeService` if popup is ever migrated.

---

## 8. Open Questions

Non-blocking — do not need answers before Phase 1:

1. **Dead code?** The popup never sends `DOWNLOAD`, `DEBUG_SHAPE`, or
   `DOWNLOAD_DEBUG_JSON` messages. Can these handlers be removed?

2. **Download concurrency limit?** What should N be in `Effect.forEach(...,
   { concurrency: N })` for batch downloads? (Default plan: 3.)

3. **Partial batch success?** Today a single `browser.downloads.download` failure
   aborts the entire batch. Should partial success be surfaced to the UI? This
   requires a popup message-shape change (new response field).

4. **Status → error mapping?** `graphqlFetch` today collapses all `!ok` into
   `"GraphQL failed: ${status}"`. Distinguishing 401/403/429 is a behavior
   *enrichment* (Phase 3+). Confirm this is acceptable.

5. **`credentials:'omit'` on `fetchProfilePicture` step 1?** Unlike
   `resolveUsernameToId` which uses `credentials:'include'`, the profile picture
   step 1 uses `'omit'`. Is this intentional?

---

## 9. Progress Log

| Date | Session | Inspected | Changed | Files modified | Checks run | Known issues | Next step |
|---|---|---|---|---|---|---|---|
| 2026-05-18 | Phase 0 | All `src/` files; `package.json`; `tsconfig.json`; `vite.config.ts` | None | `EFFECT_MIGRATION.md` (created) | none | none | Phase 1: `bun add effect`, scaffold `src/effect/` |
| 2026-05-18 | Phase 1 | `package.json`; `bun.lock` | `effect@3.21.2` added; `src/effect/errors.ts` + `src/effect/runtime.ts` created | `package.json`, `bun.lock`, `src/effect/errors.ts`, `src/effect/runtime.ts`, `EFFECT_MIGRATION.md` | typecheck ✅ lint ✅ test ✅ (46/46) | none | Phase 2: finalize `formatError`, wire `runHandler` into one handler as proof-of-concept |
| 2026-05-18 | Phase 2 | `src/background.ts:534–548`; `src/background.test.ts` GET_PREVIEW_URL tests | `formatError` added to `errors.ts`; `runHandler` finalized (errorDefaults param, uses formatError); `handleGetPreviewUrl` migrated to Effect POC; `errors.test.ts` added; AGENTS.md + EFFECT_MIGRATION.md import-convention note corrected (`.js` → `.ts`) | `src/effect/errors.ts`, `src/effect/runtime.ts`, `src/background.ts`, `src/effect/errors.test.ts`, `AGENTS.md`, `EFFECT_MIGRATION.md` | typecheck ✅ lint ✅ test ✅ (54/54) | none | Phase 3: extract `fetchBlobAsDataUrl` Effect; migrate `handleFetchVideoBlob`; dedupe with updated `handleGetPreviewUrl` |
| 2026-05-18 | Phase 3 | `src/background.ts:537–603`; existing GET_PREVIEW_URL tests | `fetchBlobAsDataUrl` extracted to `src/effect/instagram.ts`; `handleGetPreviewUrl` rewritten to one-liner via `fetchBlobAsDataUrl`; `handleFetchVideoBlob` migrated from `try/catch` to same shared Effect; `blobToDataUrl` import removed from `background.ts`; unit tests in `instagram.test.ts` (4); FETCH_VIDEO_BLOB integration tests added to `background.test.ts` (2) | `src/effect/instagram.ts`, `src/effect/instagram.test.ts`, `src/background.ts`, `src/background.test.ts`, `EFFECT_MIGRATION.md` | typecheck ✅ lint ✅ test ✅ (60/60) | none | Phase 4: Schema validation for `web_profile_info` |
| 2026-05-18 | Phase 4 | `src/background.ts:90–268`; `src/effect/` dir | `WebProfileInfoUserSchema`+`WebProfileInfoResponseSchema` added to `src/effect/schemas.ts`; `fetchWebProfileInfoUser` Effect added to `src/effect/instagram.ts`; `resolveUsernameToId` migrated (warns on `ResponseShapeUnknown`, collapses all errors to `null`); `fetchProfilePicture` step-1 migrated (converts `HttpError` → same throw message); `normalizeProfilePicture` simplified to accept typed `WebProfileInfoUser | undefined`; 5 schema unit tests; 5 instagram unit tests; 2 background integration tests for profile path | `src/effect/schemas.ts`, `src/effect/schemas.test.ts`, `src/effect/instagram.ts`, `src/effect/instagram.test.ts`, `src/background.ts`, `src/background.test.ts`, `EFFECT_MIGRATION.md`, `CLAUDE.md` | typecheck ✅ lint ✅ test ✅ (72/72) | none | Phase 5: shortcode GraphQL Schema + dedupe `handleFetchMedia`/`executeDownload` |
| 2026-05-18 | Phase 5 | `src/background.ts` full; `src/effect/` dir | `ShortcodeNodeSchema`+`ShortcodeMediaResponseSchema`+`SidecarChildNodeSchema` added to `schemas.ts`; `graphqlFetch` Effect added to `instagram.ts`; `resolveMediaEffect`+`downloadMediaEffect` added to `background.ts` (all branches: post/reel/story/highlight/profile); `handleFetchMedia`+`handleDownload` rewritten as `runHandler` one-liners; `executeDownload` removed; `normalizeShortcodeMedia` accepts typed `ShortcodeNode` (no more unsafe casts or `walkObjects` fallback); `handleDebugShape` migrated to `graphqlFetchEffect`; `walkObjects` removed; unsupported-URL assertion updated to `'Invalid Instagram URL'`; 4 new DOWNLOAD integration tests; 3 `graphqlFetch` unit tests; 4 shortcode schema tests | `src/effect/schemas.ts`, `src/effect/schemas.test.ts`, `src/effect/instagram.ts`, `src/effect/instagram.test.ts`, `src/background.ts`, `src/background.test.ts`, `EFFECT_MIGRATION.md`, `CLAUDE.md` | typecheck ✅ lint ✅ test ✅ (83/83) build ✅ | none | Phase 6: `Effect.retry` on `GraphQLRequestFailed`/`RateLimited`; `Effect.forEach` concurrency; partial-success for batch downloads |
