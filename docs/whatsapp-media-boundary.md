# WhatsApp page-to-extension media boundary

Research for [issue #111](https://github.com/zytact/GramGrab/issues/111), based on the
browser platform and GramGrab at commit `7f4d844`. This note deliberately does not inspect,
collect, or save personal WhatsApp data.

## Decision summary

Use a user-triggered, programmatically injected, short-lived bridge. Inject an **isolated-world
controller** into the active WhatsApp tab and use **MAIN-world code only for the smallest operation
that the extraction contract proves cannot be performed from the isolated world**. Transfer a
snapshot as metadata followed by bounded, ordered, base64-encoded byte chunks over an extension
port. Acknowledge chunks to provide backpressure. Cancel and expire the transfer explicitly, and
remove all page listeners and in-memory state when it settles.

The extension, not the page, should own export and download orchestration after it has accepted the
snapshot. Do not make page-created HTTP, `blob:`, or `data:` URLs the durable boundary. Do not put a
whole image or video in one `executeScript()` result or runtime message.

This preserves the no-permanent-content-script constraint: `scripting.executeScript()` makes the
runtime decision to inject, while registered content scripts are a separate persistent mechanism.
Chrome documents `executeScript()` as a runtime injection API and requires `scripting` plus either
host access or `activeTab`; Firefox documents the same permission model
([Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting),
[Firefox content scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)).

## Invariant platform facts

These facts do not depend on how Visible Status extraction is eventually specified.

### Injection and execution worlds

- `scripting.executeScript()` is temporary programmatic injection. Its target defaults to the main
  frame, and its code must be packaged with the extension. GramGrab already has `activeTab`, but it
  does not yet declare `scripting` or a WhatsApp host permission
  ([Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting),
  [current manifest generator](../apps/extension/scripts/manifest.mjs)).
- `ISOLATED` is the default world. It shares the document with the page but not its JavaScript
  globals. `MAIN` shares the page's JavaScript environment, has no content-script-only extension
  APIs, is visible and mutable by the page, and is subject to page interference. Mozilla explicitly
  warns against MAIN unless exposing the code and flowing data to the page is acceptable
  ([Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts),
  [Mozilla ExecutionWorld](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/ExecutionWorld)).
- Therefore MAIN is a privilege boundary, not a convenient default. Keep extension messaging,
  validation, sequencing, and cancellation in ISOLATED. If MAIN is required, give it a random
  per-transfer nonce and a narrow request/response schema, and check `event.source === window` at
  the isolated bridge.

### Network and page-owned media

- A page-world fetch is governed by the page's origin and same-origin policy. MV3 content-script
  fetches are also subject to the page's CORS policy. An extension service worker or extension page
  can make cross-origin requests only when granted matching host permissions
  ([Chrome cross-origin requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests),
  [Firefox content scripts](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts)).
- Host permission does not imply equivalence with a request made by the WhatsApp page. A background
  refetch can differ in origin/CORS/request context, and no browser extension API promises access to
  a page service worker's in-memory response or decrypted application state. Consequently, service
  worker or extension-origin refetch must be treated as an optimization proven by the extraction
  contract, never as the correctness path.
- A `blob:` URL is an origin-bound, revocable reference to an in-memory Blob. Cross-origin requests
  for blob URLs fail, revocation makes later dereferences fail, and document unload removes that
  document's blob URL store
  ([File API](https://w3c.github.io/FileAPI/#blob-url)). `URL.createObjectURL()` is unavailable in
  service workers
  ([MDN createObjectURL](https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static)).
  Passing a page blob URL to the extension worker therefore does not transfer ownership of its
  bytes.

### Byte transfer and serialization

- `window.postMessage()` uses structured clone and accepts a transfer list, so MAIN can hand an
  `ArrayBuffer` chunk to the isolated controller without copying ownership
  ([Window.postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)).
- Extension messaging is not serialization-compatible across the two target browsers. Chrome uses
  JSON serialization and caps a message at 64 MiB; Firefox uses structured clone
  ([Chrome messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging),
  [Mozilla incompatibilities](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#data_cloning_algorithm)).
  Raw `Blob`, `ArrayBuffer`, typed-array, or `ReadableStream` messages are therefore not a Chromium
  and Firefox contract. Use JSON-compatible envelopes and strings.
- Base64 is about one third larger than its source bytes
  ([MDN Base64](https://developer.mozilla.org/en-US/docs/Glossary/Base64#encoded_size_increase)). A
  single `data:` URL also duplicates the complete payload as a string and has browser-specific size
  ceilings, despite current Chromium and Firefox both documenting a 512 MB ceiling
  ([MDN data URLs](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Schemes/data#length_limitations)).
  This makes a whole-file data URL a poor transport even though GramGrab currently uses data URLs
  for small service-worker-created JSON and fetched previews
  ([data-url helper](../apps/extension/src/lib/data-url.ts),
  [background download path](../apps/extension/src/background.ts)).

### Download, cancellation, and lifetime

- `downloads.download()` accepts a URL and returns a download ID. HTTP(S) downloads include cookies
  for the URL's hostname. `downloads.cancel(id)` cancels an active download, while erasing download
  history does not delete the file
  ([Chrome downloads](https://developer.chrome.com/docs/extensions/reference/api/downloads),
  [Firefox downloads.cancel](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/downloads/cancel)).
  GramGrab already centralizes direct downloads through this API and already has the `downloads`
  permission ([background](../apps/extension/src/background.ts),
  [manifest generator](../apps/extension/scripts/manifest.mjs)).
- Cancelling a transfer before `downloads.download()` starts requires aborting the page fetch/stream,
  disposing buffered chunks, and acknowledging cancellation to both bridge worlds. `AbortController`
  can cancel fetch stream consumption
  ([MDN readable streams](https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams#consuming_a_fetch_using_asynchronous_iteration)).
  Cancelling after download initiation additionally requires the returned download ID.
- Chromium extension service workers can terminate and lose global state; Chrome directs extensions
  to persist important state and tolerate unexpected termination. Firefox uses an MV3 event page in
  GramGrab's current target configuration, so the two background lifetimes are not identical
  ([Chrome service-worker migration](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers),
  [Mozilla background manifest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background),
  [GramGrab manifest generator](../apps/extension/scripts/manifest.mjs)). A transfer must not depend
  solely on an uncheckpointed background global.

## Proposed boundary contract

The following is a platform-level recommendation. Field names and item identity must be reconciled
with the extraction contract before implementation.

1. A direct user gesture grants `activeTab`; the extension checks the exact top-level origin and
   injects a packaged isolated controller. Add the `scripting` permission. Prefer `activeTab` over a
   permanent WhatsApp host permission unless background refetch is later proven necessary.
2. The isolated controller creates a cryptographically random transfer ID/nonce, connects an
   extension port, and installs a narrowly scoped `window` message listener.
3. It performs DOM and same-origin work itself. Only if the extraction contract requires page
   globals, inject a small packaged MAIN function. The MAIN function emits only validated metadata,
   chunks, completion, or failure messages bearing that nonce.
4. The producer reads each selected image/video as a stream when available. MAIN-to-ISOLATED uses a
   transferred `ArrayBuffer`. ISOLATED encodes bounded chunks to base64 and sends JSON envelopes such
   as `{transferId, itemId, sequence, mediaType, byteLength, payload}`. The extension acknowledges a
   small window of chunks before the page reads more. Keep each message far below Chrome's 64 MiB
   ceiling; choose the exact chunk/window size by measured memory and throughput tests, not by the
   ceiling.
5. The receiving extension context validates sequence, declared length, aggregate size, MIME type,
   and an implementation-defined maximum before accepting bytes. It reconstructs an extension-owned
   Blob or writes to an extension-owned temporary store appropriate to the chosen export pipeline.
   It creates object/data URLs only inside a DOM-capable extension context and revokes them only
   after the download no longer needs to dereference them, based on verified behavior in both target
   browsers. The Chromium service worker must not call `URL.createObjectURL()`.
6. A transfer has an absolute deadline plus an idle deadline. Completion, cancel, timeout, tab
   navigation, port disconnect, schema failure, or size-limit failure aborts the producer, clears
   chunks, revokes locally created URLs, removes listeners, and marks the transfer terminal.
   Cancellation is idempotent. If a browser download has started, retain its download ID so a user
   cancellation can call `downloads.cancel()`.

This protocol keeps byte acquisition close to the context that can actually read the media, while
keeping page code outside the trusted export/download control plane. It also lets images, original
videos, frame export, and silent-video export consume one extension-owned byte snapshot rather than
racing an expiring page URL.

## Chromium and Firefox parity checklist

| Concern          | Portable rule                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Injection        | `scripting.executeScript`, packaged code, `scripting` + `activeTab`; feature-test MAIN support against the declared minimum versions. |
| Worlds           | ISOLATED controller in both; narrowly scoped MAIN helper only when required.                                                          |
| Page bridge      | `window.postMessage` with nonce, source/schema checks, and transferable `ArrayBuffer` chunks.                                         |
| Extension bridge | JSON-compatible envelopes and base64 chunks; do not rely on Firefox structured-clone-only types.                                      |
| Background       | Treat state as interruptible; Firefox event-page longevity is not a reason to depend on globals.                                      |
| Object URLs      | Create and revoke in a DOM-capable owner; never require `createObjectURL` in Chromium's service worker.                               |
| Downloads        | Use the shared downloads API and retain IDs for cancellation.                                                                         |
| Permissions      | Add `scripting`; keep `activeTab`; add a WhatsApp host permission only for a separately justified background fetch capability.        |

## Extraction-contract decisions still blocking implementation

These are not browser facts and must not be guessed in this ticket:

- What exactly identifies the current **Visible Status** and its ordered media items, including the
  stability and privacy properties of item IDs.
- Whether bytes are available through a same-origin HTTP response, a page-created blob URL, DOM
  elements, Cache API/service-worker state, encrypted storage, or private page JavaScript objects.
- Whether ISOLATED can dereference every supported image/video source. This decides whether MAIN is
  needed at all and which operation it alone performs.
- Whether the returned bytes are already the final decrypted original, a preview/transcode, or a
  stream that changes while viewed, and which MIME/container metadata is authoritative.
- Expected maximum item and collection sizes, which determine chunk size, receive-window size,
  aggregate limits, temporary storage, and whether memory-only reconstruction is acceptable.
- Snapshot semantics: which items are included, when the snapshot becomes immutable, whether a
  Status expiring or the viewer advancing invalidates it, and whether retry may reacquire bytes.
- The ownership boundary needed by each export mode. Direct export can begin once its item is
  validated; frame and silent-video exports may require seekable, extension-owned bytes.
- User cancellation semantics before acquisition, mid-transfer, during transformation, and after
  `downloads.download()` has accepted the URL.

Until those points are fixed, the stable decision is the architecture above, not a WhatsApp-specific
extractor implementation. In particular, do not grant broad hosts, persist page media, or introduce a
permanent content script merely to bypass an unknown extraction requirement.
