# AGENTS.md

## Project

GramGrab is a Chrome/Firefox MV3 extension for downloading Instagram media. No content scripts.

## Commands

```bash
bun run build           # chromium + firefox
bun run build:chromium  # → extension/chromium/
bun run build:firefox   # → extension/firefox/
bun run dev             # chromium watch (alias for dev:chromium)
bun run dev:firefox     # firefox watch
bun run lint            # eslint .
bun run lint:fix
bun run format          # prettier --write
bun run format:check
bun run typecheck       # tsc --noEmit
bun run test            # vitest run
bun run test:watch
bun run package:firefox # build + XPI
bun run package:chromium# build + CRX (generates/uses chromium.pem key)
```

Verify in order: `lint` + `typecheck` together, then `test`.
Never commit yourself.

## Architecture

- **Vite root**: `templates/`. Entry: `templates/popup.html` (React app at `src/App.tsx`). Background worker (`src/background.ts`) bundled directly as `js/background.js` — no HTML wrapper.
- **Output**: `extension/{chromium,firefox}/`. Post-build (`scripts/postbuild.mjs`) generates per-browser `manifest.json`, copies icons, writes stub polyfill files. Chromium gets `service_worker`, Firefox gets `scripts`.
- **Message dispatcher** (`background.ts:639`): all listeners registered synchronously at module top. Uses `sendResponse` + `return true` (cross-browser-safe pattern), NOT Promise-return. The popup (`popup.tsx`) sends `FETCH_MEDIA`, `DOWNLOAD_MEDIA`, `GET_PREVIEW_URL`, `FETCH_VIDEO_BLOB` messages.
- **`browser` global**: Proxy-based shim (`src/lib/browser.ts`) resolving `globalThis.browser` → `globalThis.chrome` → no-op stub. Promisifies callback APIs.

## Vendored Repositories

This project vendors external repositories under @repos/

  - Use vendored repositories as read-only reference material when working with related libraries
  - Prefer examples and patterns from the vendored source code over generated guesses or web search results
  - Do not edit files under @repos/ unless explicitly asked
  - Do not import from @repos/ - application code should continue importing from normal package dependencies
  -  When writing Effect code, inspect @repos/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

## Effect Migration (in progress)

Phases 1–5 complete. `src/effect/` uses `.ts` import extensions (e.g. `./errors.ts`). Legacy `src/` files use extensionless imports. `FETCH_MEDIA` and `DOWNLOAD` both use the shared `resolveMediaEffect` in `background.ts`. See `EFFECT_MIGRATION.md`.

## TypeScript & Style

- `moduleResolution: bundler`, `verbatimModuleSyntax: true`, `allowImportingTsExtensions: true`, `noUncheckedIndexedAccess: true` — array/object access may return `undefined`.
- `no-console` rule: only `console.warn`/`console.error` allowed.
- Prettier: single quotes, trailing commas (es5), 100 print width, arrow parens avoid.

## Testing

- Vitest + jsdom. Files: `src/**/*.test.{ts,tsx}`. Setup: `src/test/setup.ts` (polyfills Blob.arrayBuffer, installs mock `globalThis.browser`).
- Test helpers in `setup.ts`: `resetBrowserMocks()`, `setMockMessageHandler(type, handler)`, `getDownloadCalls()`.
- Background tests dynamically import `background.ts` to capture the registered listener.
- Coverage: `bun run test` generates text/json/html reports (v8 provider).

## Pre-commit

Husky runs `bun run lint-staged` (eslint --fix + prettier --write on staged `.ts/.tsx/.js/.mjs`).
