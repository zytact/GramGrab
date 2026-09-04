# AGENTS.md

## Project

GramGrab resolves Instagram and WhatsApp media into items a person can inspect and download. It ships as a Chrome/Firefox MV3 extension plus a local CLI bridge.

- `apps/extension` - popup, background worker, runner document, WhatsApp page controller
- `apps/cli` and `apps/native-host` - terminal access to the same operations, bundled by `vp pack` into `artifacts/`
- `packages/protocol` - wire contracts shared by extension, CLI, and native host

Scripts run through `vp run <script>`; prefer `vp` over package-manager wrappers. Verify in this order after any change: `vp check` (typecheck, lint, format in one), then `vp test run`, then `vp run fallow`.

## Page access

The manifest declares no content scripts and no WhatsApp host permission. `apps/extension/scripts/verify-whatsapp-package.mjs` enforces both against built output, so treat them as fixed. Page execution still happens two ways:

- **WhatsApp controller.** The popup drives a capture session (`whatsapp/capture.ts`), which calls `scripting.executeScript` to inject `js/whatsapp-controller.js` into the top frame of the active tab in the `ISOLATED` world, then speaks a bounded chunk protocol to it over a `tabs.connect` port. One invocation, one capture, under `activeTab`. See `docs/adr/0001-activetab-for-whatsapp-page-access.md`.
- **Runner document.** Frame extraction and silent-video re-encode need DOM and media APIs a service worker lacks, so the background worker opens `runner.html` in a minimized popup window (`getRunner` in `background.ts`) and sends it a `RUN_EXPORT` message. `src/runner.ts` executes the plan and reports back with `RUNNER_READY` and `RUNNER_PROGRESS`.

Keep the WhatsApp controller entry (`src/whatsapp/controller-entry.ts`) free of exports and external imports so it stays injectable as a classic packaged script.

## Messaging

- **Contract.** `src/messaging/contracts.ts` is the discriminated union of every message the extension sends itself, keyed by the wire `type`, with each request as an Effect `Schema` and each response as a compile-time type. `messageHandlers` in `background.ts` is typed from it, so a handler that returns the wrong shape is a type error. Add a message type by adding a schema to `MessageSchema`, a `MessageResponses` entry, a `MESSAGE_REFUSALS` entry, and a handler.
- **Dispatch.** The single `browser.runtime.onMessage.addListener` in `background.ts` decodes once via `decodeMessage`, so handlers receive typed payloads and never cast. It answers with `sendResponse` plus `return true` (cross-browser-safe), not a returned Promise, and handles the runner's `RUNNER_READY` and `RUNNER_PROGRESS` inline. The popup and runner send through `src/messaging/send.ts`, which correlates the response type to the request at each call site.
- **Version skew.** A message type this build does not know is `foreign`: ignored with no response, the same as a message meant for another document. A known type whose payload will not decode is `unsupported` and gets that type's entry from `MESSAGE_REFUSALS`, which reuses an existing failure code from that message's own subsystem rather than inventing one. Unknown extra fields decode fine and are dropped, so additive changes from a newer sender are safe, and responses are never decoded, so additive changes from a newer receiver are too.

## WhatsApp acquisition

`apps/extension/src/whatsapp/` acquires one **Visible Status** at a time and hands the bytes to an edit session. Its privacy constraints are binding on every change: `docs/whatsapp-privacy.md` is the contract, `docs/adr/0001`-`0004` record why. Load those before touching this path. The invariants that most often get broken by accident:

- Page reach is `activeTab` plus `scripting`. A WhatsApp host permission, persistent or optional, is out.
- Captured bytes live in memory only. No `storage`, IndexedDB, OPFS, or filesystem.
- One flat 10-minute edit lease from capture-complete. Interaction never resets or extends it, and terminal operations are pre-flight checked against the remaining lease.
- WhatsApp diagnostics are a distinct structural-only type that cannot hold a URL, name, or identifier.
- A WhatsApp history entry is a receipt, not a handle: no re-download affordance, no display name.

Synthetic tests are authoritative for every extension-owned boundary; `docs/whatsapp-boundary-coverage.md` maps boundary to test. `docs/whatsapp-live-verification.md` is a human-run procedure for browser facts tests cannot establish.

## Vendored Repositories

This project vendors external repositories under `.repos/`.

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under `.repos/` unless explicitly asked
- Do not import from `.repos/` - application code should continue importing from normal package dependencies
- When writing Effect code, inspect `.repos/effect/` for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

## Testing

Setup is `apps/extension/src/test/setup.ts`, which polyfills `Blob.arrayBuffer` and installs a mock `globalThis.browser`. Helpers: `resetBrowserMocks()`, `setMockMessageHandler(type, handler)`, `getDownloadCalls()`. Background tests dynamically import `background.ts` to capture the registered listener.

## IG Schema Fixtures & Strict-Schema Posture

All Instagram API responses are decoded through Effect `Schema` tagged unions, not ad-hoc casts. The posture is **strict + loud**: decode failures surface as `ResponseShapeUnknown` with a user-actionable message. Unknown `__typename` values pass through silently so partial changes do not brick the whole response.

Sanitized fixtures live in `apps/extension/src/effect/__fixtures__/` (see the README there) and are decoded by `schemas.fixtures.test.ts`. Handwritten tests in `schemas.test.ts` cover edge cases only: missing required fields, null variants, Unknown passthrough, union dispatch.

When `ResponseShapeUnknown` fires in the wild:

1. If the request itself stopped working (App ID, ASBD ID, GraphQL doc ID, endpoint, transport), follow `docs/instagram-protocol.md` first.
2. `vp run generate:ig-fixtures`, then paste `.local/capture-ig-fixtures.mjs` into DevTools on a logged-in `instagram.com`.
3. Download raw JSON into `.local/raw-fixtures/`, review `vp run sanitize:ig-fixtures`, then install with `vp run sanitize:ig-fixtures -- --write`. The sanitizer is the privacy boundary for committed captures.
4. `vp test run`. Failing fixture tests show exactly what changed.
5. Update `apps/extension/src/effect/schemas.ts`, re-run tests, ship sanitized fixtures only.

## Operation errors

The canonical failure registry and compatibility contract live in `docs/error-model.md`. When adding a failure code, update its producer, schema, normalizer, exhaustive presentation/recovery policy, diagnostics policy, documentation row, and focused tests together. Render diagnostic causes only through the diagnostics surface, never as ordinary UI copy.

## Domain language

Ubiquitous language lives in `CONTEXT.md`; use its terms and honor its _Avoid_ list. Ambiguous decisions are recorded in `docs/adr/`.
