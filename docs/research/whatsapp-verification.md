# WhatsApp Visible Status verification without personal fixtures

Research for [issue #114](https://github.com/zytact/GramGrab/issues/114), based on the repository at `7f4d844` and primary browser, Fetch, and HTTP sources. This note defines reusable verification facts and a privacy-safe evidence procedure. It does not choose the extraction contract tracked by [#110](https://github.com/zytact/GramGrab/issues/110) or the page-to-extension transfer contract tracked by [#111](https://github.com/zytact/GramGrab/issues/111).

## Conclusion

GramGrab does not need committed WhatsApp responses, decrypted media, or recordings of a personal session to prove the feature. The sufficient evidence package is:

1. deterministic Vitest/jsdom contract tests using invented DOM and message objects;
2. byte-exact tests using generated image and video test cards, `data:` URLs, and a loopback HTTP server that implements full-body, streamed, byte-range, denial, interruption, and expiry responses;
3. built-extension end-to-end tests for Chromium where automation is reliable;
4. one redacted manual acceptance matrix for the built Chromium and Firefox packages, exercised with purpose-made non-personal test media; and
5. a repository guard proving that no prohibited live-session values enter fixtures, snapshots, History, diagnostics, screenshots, or test output.

This proves GramGrab's behavior at its owned boundaries. It cannot prove an extraction selector, automatic-advancement rule, or transfer lifetime until #110 and #111 define those contracts.

## Why synthetic evidence is valid

Chrome's testing guidance explicitly separates isolated unit tests, where extension APIs can be mocked, from end-to-end tests that load the built extension and exercise user-visible flows. It recommends basing integration assertions on visible behavior instead of private extension state ([unit testing](https://developer.chrome.com/docs/extensions/how-to/test/unit-testing), [end-to-end testing](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing)). GramGrab already follows that shape:

- `apps/extension/src/test/setup.ts` supplies browser API mocks and routes messages through the real background listener.
- `apps/extension/src/integration.test.tsx` drives rendered UI and asserts download calls.
- `apps/extension/src/background.test.ts` already uses invented image `data:` URLs.
- `apps/extension/src/workspace/contracts.ts` rejects expired transfer snapshots and removes `data:` previews before transfer.

Therefore, committed fixtures should describe only GramGrab's chosen normalized boundary, not a captured WhatsApp implementation. Invented objects are sufficient for schema validation, unknown-shape behavior, ordering, media eligibility, identity handling, side-effect boundaries, and failure normalization. Tests must use reserved names such as `CONTACT_A`, opaque fake IDs such as `status-001`, and generated media bytes. They must never resemble or derive from an observed account.

Any page, message, or persisted value that crosses into Effect code should be decoded from `unknown` through an Effect Schema and normalized to the canonical tagged failure registry at that boundary. Effect-based clock, cancellation, and schema tests should use the repository's Effect-aware Vitest patterns so expiry and interruption stay deterministic and cancellation is not collapsed into an ordinary business failure.

## Automated verification matrix

### Extraction adapter, after #110

Use minimal invented page states for exactly one explicitly open Visible Status:

- eligible image and eligible video;
- text, link-preview, sticker, absent, loading, and unsupported forms;
- missing, duplicate, malformed, and unknown required structural markers;
- an adjacent Status present but never returned;
- a visible item replaced in place, removed, or advanced automatically;
- navigation away, viewer close, tab close, and page reload during extraction;
- one acquisition request producing at most one immutable normalized snapshot; and
- no API call, synthetic click, or adjacent-item enumeration by extraction code.

Automatic advancement should be tested as an adversarial page-state transition, not by reproducing WhatsApp timing. With fake timers, replace the synthetic visible node before, during, and after snapshot creation. The chosen contract must say whether the operation atomically returns the item that was visible at invocation or fails as changed/stale. It must never silently return the next item. The exact observation primitive and identity comparison remain blocked on #110.

### Image data URLs

Use a tiny generated PNG or JPEG with known dimensions and digest. Construct `data:<media-type>;base64,<bytes>`, decode through the real boundary, and assert MIME type, byte length, digest, dimensions, filename policy, preview, and download outcome. Cover malformed base64, an empty payload, a mismatched declared type, a configured size limit, cancellation, and sanitization from transferable or durable state.

The `data:` syntax and base64 marker are standardized by [RFC 2397](https://www.rfc-editor.org/rfc/rfc2397). The RFC describes the scheme as immediate inline data and notes that it is useful for short values. Consequently, a `data:` URL is a good deterministic image input and small-message test, but it is not evidence that a large video transfer design is memory-safe.

### Same-origin streaming and byte ranges

Run a loopback server on a random port and serve generated MP4/WebM test-card bytes from the same origin as the synthetic page. The server should record only method, path token, request headers, response status, and byte counts. It must not record bodies or URLs copied from a live session.

Cover:

- `200` with a known `Content-Length`;
- `200` with a `ReadableStream` body delivered in several chunks;
- a valid `Range: bytes=0-N` request returning `206`, `Content-Range`, `Content-Length`, and exactly the selected bytes;
- a later range and an open-ended range;
- an unsatisfiable range returning `416`;
- a server that ignores `Range` and returns `200`, which clients must handle honestly because range support is optional;
- a truncated stream, mid-stream abort, cancellation, timeout, and retry policy; and
- URL expiry simulated by a controllable clock or one-shot token returning `403`/`404` after the boundary-defined lifetime.

The Fetch Standard exposes a response body as a `ReadableStream` and distinguishes incremental processing from consuming the complete body ([WHATWG Fetch Standard](https://fetch.spec.whatwg.org/#body-mixin)). HTTP defines `206 Partial Content`, `Content-Range`, and the possibility that a server ignores or rejects a range request ([RFC 9110, sections 14 and 15.3.7](https://www.rfc-editor.org/rfc/rfc9110.html#name-range-requests)). Tests should assert protocol semantics and final bytes, not chunk sizes, because chunking is not an application contract.

The test server models same-origin behavior only. It does not justify extension-origin fetching of an arbitrary signed CDN URL. Chrome documents that extension service workers and extension pages need host permission for cross-origin fetches, while content scripts remain subject to the page origin's same-origin policy ([cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)). Which context owns the bytes is a #111 decision.

### Transfer, expiry, and persistence, after #111

Reuse the repository's fake-clock posture around `WORKSPACE_TRANSFER_TTL_MS` and test the chosen transfer envelope at `createdAt`, immediately before expiry, exactly at expiry, and after expiry. Also test delayed receiver startup, sender teardown, double claim, cancellation, replay, partial transfer, and browser/runtime restart.

Every assertion should verify both positive output and negative retention:

- ephemeral payload is available only to the intended in-flight operation;
- expiry and cancellation revoke or make it unreachable;
- workspace transfer, session storage, local storage, History, diagnostics, and ordinary errors contain no media bytes, media keys, signed URLs, contact identifiers, or raw page structures;
- a stale operation cannot accidentally bind to the automatically advanced Status; and
- download acceptance records only the final privacy contract chosen by #113.

The current workspace snapshot has a 60-second transfer TTL and rejects snapshots whose `expiresAt` is not in the future, but that is an existing implementation fact, not automatically the correct lifetime for decrypted WhatsApp bytes.

### Permissions and build checks

The current manifest requests Instagram and Facebook CDN hosts only. Verification must fail if WhatsApp access works only because a developer profile granted undeclared access. For each browser, assert the generated manifest and then exercise granted, denied, revoked, and navigation-away states.

Prefer an optional `https://web.whatsapp.com/*` host permission if the chosen design can request it at the feature's user gesture. Chrome recommends optional permissions for optional features because they reduce standing privilege and explains that `permissions.request()` must run from a user gesture ([Permissions API](https://developer.chrome.com/docs/extensions/reference/api/permissions)). Whether `activeTab`, `scripting`, an optional host permission, or some combination is sufficient depends on #110 and #111. Do not add CDN-wide host patterns merely to make tests pass.

### Browser end-to-end coverage

For Chromium, automate a hermetic synthetic page plus the built unpacked extension. Chrome documents loading the built extension with Puppeteer, waiting for its MV3 service worker, and opening the popup; its end-to-end guidance also supports navigating directly to an extension page ([Puppeteer extension testing](https://developer.chrome.com/docs/extensions/how-to/test/puppeteer), [end-to-end testing](https://developer.chrome.com/docs/extensions/how-to/test/end-to-end-testing)). Assert only visible state and accepted download bytes.

Firefox parity must use the generated Firefox package, not infer compatibility from jsdom or Chromium. Mozilla documents loading a temporary add-on from `about:debugging` and using `web-ext run` for development ([Mozilla WebExtension testing](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Your_second_WebExtension#testing_it_out)). A future Firefox automation harness is valuable, but the ticket can initially be satisfied by the controlled manual matrix below because it verifies the actual Firefox background-script packaging and permission UI.

## Redacted live-session procedure

Use two dedicated QA accounts with no real contacts or chat history. Account A posts one purpose-made test image and one purpose-made short video containing only a test-card pattern, media type, dimensions, and a random run nonce. Account B opens exactly that Status on WhatsApp Web. Delete the test media after the run according to the provider's available controls. Do not reuse any personal account or personal media.

For the current Chromium and Firefox release versions:

1. Start with a fresh browser profile, install the locally built package, and record browser version, extension build commit, package digest, operating system, date, and pass/fail only.
2. Verify the permission prompt and denial recovery. Grant access only through the intended user action.
3. Open the synthetic image Status, invoke GramGrab once, verify one preview and a byte-identical downloaded test card, delete the local download immediately after verification, then close the viewer.
4. Repeat for the synthetic video and every applicable export mode. Verify playback, dimensions/duration within the mode's documented tolerance, cancellation, and accepted outcome, then delete every local output immediately.
5. Repeat while the viewer automatically advances or is manually advanced during acquisition. Record only which defined outcome occurred and whether the next item was ever downloaded incorrectly.
6. Exercise expiry by delaying or invalidating the test operation according to the chosen #111 contract, then verify failure and cleanup.
7. Revoke permission and verify that acquisition stops with the defined recovery path. Restart the browser and verify that no decrypted content or session locator is recoverable.
8. Inspect GramGrab storage and diagnostics for prohibited fields using a key-name/shape allowlist. Record only the allowlist result and counts, never values.

Do not save HAR files, DevTools Network exports, console dumps, page HTML, extension storage exports, screenshots of WhatsApp, raw URLs, response headers, stack traces containing URLs, downloaded media, or screen recordings. If a screenshot of GramGrab UI is necessary, capture only the extension surface after replacing its contents with a synthetic local replay. Redaction after capture is not sufficient for prohibited values because the unredacted original would already have been retained.

The durable evidence artifact should be a Markdown or JSON matrix containing only:

- run ID unrelated to an account;
- browser/version, OS, build commit, and package digest;
- scenario ID and expected normalized outcome;
- pass/fail, byte count, media type, synthetic test-card digest, and timing bucket;
- permission state and cleanup checks as booleans; and
- a reviewer signature or initials unrelated to the WhatsApp accounts.

## Required repository safeguards

- Keep generated media under a clearly named synthetic fixture directory and generate it reproducibly where practical.
- Add a test that recursively inspects all emitted snapshots, History records, diagnostics, and errors for URL credentials/query strings, media-key-like fields, and binary/data-URL payloads.
- Add a pre-commit or CI fixture policy check that rejects WhatsApp domains, signed-query parameter names, phone-number-like identifiers, long unexplained base64, and files outside the explicit synthetic allowlist. Treat this as defense in depth, not proof that arbitrary captured data was safely anonymized.
- Make test failures print scenario labels, byte counts, digests, and symbolic failure codes only. Never interpolate the input object or URL into assertion messages.
- Keep live-session steps manual and local. Commit only the redacted result matrix, if durable evidence is required.

## Decisions still blocked

The following cannot be finalized in #114 before #110 and #111 resolve:

- which observable page structure establishes that one photo or video Status is visibly open;
- the stable identity used to detect automatic advancement without retaining a contact or service identifier;
- whether image bytes cross as a `data:` URL, `ArrayBuffer`, stream, page-owned URL, or another bounded envelope;
- which context performs video reads and range requests;
- exact size, lifetime, cancellation, replay, and ownership limits;
- the minimum `activeTab`, `scripting`, optional host, or other permission set; and
- the precise expected outcome when the visible Status changes during acquisition.

Once those decisions exist, this note can be converted directly into acceptance tests by replacing each conditional phrase with the chosen invariant. Until then, it establishes a privacy-safe evidence method but does not claim that WhatsApp support itself has been proven.
