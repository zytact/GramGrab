# GramGrab architecture

This document describes the architecture of the extension as it is implemented today. The primary entry points are [`src/popup.tsx`](../src/popup.tsx), [`src/background.ts`](../src/background.ts), and the browser adapter in [`src/lib/browser.ts`](../src/lib/browser.ts).

## Runtime shape

GramGrab is a Manifest V3 extension with two runtime surfaces:

```text
Instagram tab
     |
     | activeTab/tabs URL detection, context-menu actions
     v
popup.html -> templates/popup.tsx -> src/popup.tsx
     |                                      |
     | browser.runtime.sendMessage              | local frame/silent-video work
     v                                      v
background worker <-> Instagram APIs       browser downloads/storage/tabs
     |
     +-> normalized media and typed operation results
```

There are no content scripts. The popup can read the active tab URL when it opens, and the background worker can create or update a dedicated workspace tab. This keeps GramGrab out of Instagram page execution contexts and avoids injecting code into pages.

The Vite root is [`templates/`](../templates/). `templates/popup.html` loads the React entry point `templates/popup.tsx`, which renders the default export from `src/popup.tsx`. The background entry is `src/background.ts`; it is bundled directly to `js/background.js` without an HTML wrapper. [`scripts/postbuild.mjs`](../scripts/postbuild.mjs) writes the browser-specific manifest and copies distribution assets.

## Popup responsibilities

The popup owns the user-facing session. It accepts or detects an Instagram URL, starts a fetch, displays normalized media items, manages selection, loads previews, and coordinates download attempts. It also owns frame extraction and silent-video conversion because those operations need browser media APIs and temporary storage that are not part of the background message contract.

The main popup hooks split the work into focused areas:

- [`src/workspace/use-media-fetch.ts`](../src/workspace/use-media-fetch.ts) requests and displays media results.
- [`src/download/use-download-attempt.ts`](../src/download/use-download-attempt.ts) tracks per-item attempts, retries, fallbacks, and stale-response protection.
- [`src/frame-export/`](../src/frame-export/) selects a timestamp and names exported JPEG frames.
- [`src/silent-video/`](../src/silent-video/) creates a video without audio, with progress and cleanup handling.
- [`src/workspace/use-workspace-surface.ts`](../src/workspace/use-workspace-surface.ts) restores and publishes workspace state.

The popup does not treat a browser-accepted download as proof that the file finished. A started result means the browser accepted the request; completion or interruption remains visible in the browser download UI.

## Background worker and messages

The background worker owns Instagram network requests, browser downloads, local history mutations, context menus, and workspace tab transfers. All message handlers are collected in one dispatcher near the end of [`src/background.ts`](../src/background.ts).

Important message groups are:

| Messages | Responsibility |
| --- | --- |
| `FETCH_MEDIA` | Resolve a supported Instagram URL and return normalized items with local history markers. |
| `GET_PREVIEW_URL`, `FETCH_VIDEO_BLOB` | Fetch CDN content when the popup needs a data URL for a preview or frame operation. |
| `DOWNLOAD_MEDIA` | Start one or more browser downloads with bounded concurrency and return per-item results. |
| `GET_DOWNLOAD_HISTORY`, `DELETE_HISTORY_ENTRY`, `CLEAR_DOWNLOAD_HISTORY`, `REDOWNLOAD_HISTORY_ENTRY` | Read, mutate, or refetch local download history. |
| `RECORD_FRAME_EXPORT`, `RECORD_SILENT_EXPORT` | Record successful popup-side derived exports in the same local history. |
| `DEBUG_SHAPE`, `DOWNLOAD_DEBUG_JSON` | Produce and save explicitly requested diagnostics for protocol debugging. |

Listeners are registered synchronously at module initialization. The listener resolves a handler, starts the asynchronous operation, calls `sendResponse` with its result, and returns `true`. This `sendResponse` plus `return true` pattern is used for reliable asynchronous responses across Chromium and Firefox MV3 behavior.

## Browser compatibility

[`src/lib/browser.ts`](../src/lib/browser.ts) exposes only the browser APIs GramGrab uses. A native `globalThis.browser` is preferred for Firefox. On Chromium, callback-based `chrome.*` APIs are wrapped in promises. In tests and non-extension environments, a no-op implementation prevents imports from throwing.

The generated manifests differ only where browser behavior requires it. Chromium uses `background.service_worker: "js/background.js"`; Firefox uses `background.scripts: ["js/background.js"]` and adds its Gecko extension ID. Both targets share the same TypeScript application code.

## Instagram request flow

1. The popup sends `FETCH_MEDIA` with a user-entered or detected URL.
2. [`src/workspace/contracts.ts`](../src/workspace/contracts.ts) canonicalizes supported post, reel, story, highlight, and profile URLs.
3. The background resolves profile usernames when necessary and selects the relevant Instagram endpoint and operation configuration.
4. [`src/effect/instagram.ts`](../src/effect/instagram.ts) performs authenticated requests with `credentials: 'include'`, retries transient network, server, and rate-limit failures, and fetches CDN blobs without credentials when appropriate.
5. [`src/effect/schemas.ts`](../src/effect/schemas.ts) decodes response envelopes and tagged media variants with Effect Schema.
6. The background normalizes decoded nodes into media items containing stable item indexes, optional media IDs, filenames, preview URLs, and dimensions.
7. The popup renders the results and later sends selected download operations.

The schema posture is strict and loud for required response structure. Decode failures become `ResponseShapeUnknown`, surfaced to the user as an Instagram-format change that needs an extension update. Unknown `__typename` values are passed through so a new partial variant can be skipped without bricking an otherwise usable response. The failure registry and presentation policy are documented in [`docs/error-model.md`](error-model.md).

## Downloads, retries, and derived exports

Each selected item gets a stable operation ID and a fresh request ID for each execution. The reducer in [`src/download/attempt.ts`](../src/download/attempt.ts) uses those IDs to reject stale responses. Failures can be retried according to the error policy, and failed derived operations can fall back to the original media URL.

Direct downloads are delegated to `browser.downloads.download()` by the background worker. A successful browser handoff is recorded as an accepted history entry. Frame exports fetch a video blob, decode it in the popup, draw the requested timestamp to a canvas, and download a JPEG. Silent-video exports use the modules in [`src/silent-video/`](../src/silent-video/) to create a temporary no-audio MP4, then clean up temporary storage where the browser permits it.

## History and workspace transfer

[`src/history/repository.ts`](../src/history/repository.ts) stores a versioned, bounded list under the `download-history` key. Entries deliberately contain source identity, media identity, media type, filename metadata, export mode, timestamp, and accepted outcome. They do not contain media files or expiring CDN URLs. Mutations are serialized through a queue, and malformed or old entries are repaired or ignored according to the repository contract.

History markers are attached to fetched media so the popup can show repeat downloads. Redownload first refetches the source and reconciles the stored item by media ID or stable item identity. If matching is missing or ambiguous, history is preserved and no unsafe download is started.

The optional workspace is a popup-sized page opened in a browser tab. [`src/workspace/coordinator.ts`](../src/workspace/coordinator.ts) stores a sanitized versioned snapshot, opens or focuses one workspace tab, and claims the snapshot once. Transfers use a short TTL and namespaced offer keys. Context-menu actions create or replace this workspace with an `open` or `fetch` intent.

## Fixtures and schema maintenance

Committed fixtures under [`src/effect/__fixtures__/`](../src/effect/__fixtures__/) are sanitized structural snapshots of real Instagram responses. [`src/effect/schemas.fixtures.test.ts`](../src/effect/schemas.fixtures.test.ts) exercises realistic response shapes, while handwritten schema tests cover edge cases such as missing fields, null variants, union dispatch, and unknown type names.

When Instagram changes a response, capture fresh data locally with the fixture capture workflow, sanitize it, update the schema, and run the fixture tests. Raw captures remain local. The full workflow is documented in [`src/effect/__fixtures__/README.md`](../src/effect/__fixtures__/README.md) and [`docs/instagram-protocol.md`](instagram-protocol.md).

## Trust boundaries and permissions

The extension has one external trust boundary: Instagram's undocumented APIs and signed CDN URLs. The browser session supplies Instagram authentication through normal extension requests; GramGrab does not operate a server-side account session. CDN URLs are time-limited and may stop working before a download begins or completes.

The generated manifests declare:

| Permission | Purpose |
| --- | --- |
| `downloads` | Save media files and debug exports. |
| `storage` | Persist bounded download history and short-lived workspace transfers. |
| `activeTab` | Temporarily access the current tab when invoked. |
| `tabs` | Detect the active Instagram URL and create, focus, or update the workspace tab. |
| `contextMenus` | Offer GramGrab actions for supported pages and links. |
| `https://*.instagram.com/*` | Reach Instagram metadata and GraphQL endpoints. |
| `https://*.fbcdn.net/*` | Fetch Instagram media previews and video blobs from its CDN. |

No content-script permission is needed. Local persistence is limited to the extension storage area and is never presented as a remote backup or telemetry stream. Diagnostics are opt-in and copied or downloaded only after the user requests them; they exclude cookies, request headers, and browser storage contents.

## Tradeoffs

- A popup plus background worker keeps page permissions small and makes browser download APIs available in one place, at the cost of explicit message contracts and workspace transfer code.
- A browser shim avoids maintaining separate Chromium and Firefox implementations, while preserving the callback-safe listener contract required by the two MV3 environments.
- Strict schemas catch silent protocol drift early and make failures actionable, while requiring fixture refreshes when Instagram changes its undocumented response shapes.
- Local history uses durable identity metadata instead of cached media. This keeps storage bounded and avoids stale files, but redownload must refetch the source and can fail when content disappears.
- Client-side frame extraction and silent conversion avoid a media-processing service and keep user media local, but depend on browser media capabilities and temporary storage.
