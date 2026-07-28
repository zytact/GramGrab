# AGENTS.md

## Project

GramGrab is a Chrome/Firefox MV3 extension for downloading Instagram media. No content scripts.

## Commands

```bash
vp run build              # cached chromium + firefox build workflow
vp run build:chromium     # → extension/chromium/
vp run build:firefox      # → extension/firefox/
vp run dev                # chromium watch
vp run dev:firefox        # firefox watch
vp lint .                 # lint the repo
vp lint . --fix
vp fmt .                  # format the repo
vp fmt --check .
tsc --noEmit              # typecheck
vp test run               # run tests once
vp test                   # watch mode
vp run fallow             # run fallow
vp run package:firefox    # cached build + XPI
vp run package:chromium   # cached build + CRX (generates/uses chromium.pem key)
```

Use Vite+ as the primary workflow surface. Prefer `vp` commands and `vp run <script>` / `vp run <task>` over package-manager wrappers.

Verify in order: `vp lint .` + `tsc --noEmit` together, then `vp test run` and finally `vp run fallow`.

## Architecture

- **Vite root**: `apps/extension/templates/`. Entry: `apps/extension/templates/popup.html` (React app at `apps/extension/src/popup.tsx`). Background worker (`apps/extension/src/background.ts`) bundled directly as `js/background.js` — no HTML wrapper.
- **Output**: `extension/{chromium,firefox}/`. Post-build (`apps/extension/scripts/postbuild.mjs`) generates per-browser `manifest.json`, copies icons, writes stub polyfill files. Chromium gets `service_worker`, Firefox gets `scripts`.
- **Message dispatcher** (`background.ts:639`): all listeners registered synchronously at module top. Uses `sendResponse` + `return true` (cross-browser-safe pattern), NOT Promise-return. The popup (`popup.tsx`) sends `FETCH_MEDIA`, `DOWNLOAD_MEDIA`, `GET_PREVIEW_URL`, `FETCH_VIDEO_BLOB` messages.
- **`browser` global**: Proxy-based shim (`apps/extension/src/lib/browser.ts`) resolving `globalThis.browser` → `globalThis.chrome` → no-op stub. Promisifies callback APIs.

## Vendored Repositories

This project vendors external repositories under `.repos/`.

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under `.repos/` unless explicitly asked
- Do not import from `.repos/` - application code should continue importing from normal package dependencies
- When writing Effect code, inspect `.repos/effect/` for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

## Testing

- Vitest + jsdom. Files: `apps/extension/src/**/*.test.{ts,tsx}`. Setup: `apps/extension/src/test/setup.ts` (polyfills Blob.arrayBuffer, installs mock `globalThis.browser`).
- Test helpers in `setup.ts`: `resetBrowserMocks()`, `setMockMessageHandler(type, handler)`, `getDownloadCalls()`.
- Background tests dynamically import `background.ts` to capture the registered listener.
- Coverage: `vp test run` generates text/json/html reports (v8 provider).

## IG Schema Fixtures & Strict-Schema Posture

All Instagram API responses are decoded through Effect `Schema` tagged unions — not via ad-hoc casts. The posture is **strict + loud**: schema decode failures surface as `ResponseShapeUnknown` with a user-actionable message ("Instagram changed their format — please update the extension"). Unknown `__typename` values are passed through silently (B2) so partial changes don't brick the whole response.

Real API response fixtures live in `apps/extension/src/effect/__fixtures__/` (see the README there). They are decoded by `apps/extension/src/effect/schemas.fixtures.test.ts`. **Handwritten tests in `schemas.test.ts` cover edge cases only** (missing required fields, null variants, Unknown passthrough, union dispatch) — not realistic happy paths.

**When `ResponseShapeUnknown` fires in the wild:**

1. Run `apps/extension/scripts/capture-ig-fixtures.mjs` in the DevTools console on `instagram.com`.
2. Replace the relevant file(s) in `apps/extension/src/effect/__fixtures__/`.
3. `vp test run` — failing fixture tests show what changed.
4. Update `apps/extension/src/effect/schemas.ts` to match, re-run tests, ship.

## Domain language

This repo has a domain glossary at `CONTEXT.md`.

Read it when working on domain terminology, product concepts, naming, business rules, user-facing language, or when interpreting ambiguous terms (notably the overloaded **Reel** and **Unknown**). Prefer the canonical terms defined there, and avoid aliases listed as discouraged.

## Operation errors

The canonical failure registry and compatibility contract live in `docs/error-model.md`. When adding a failure code, update its producer, schema, normalizer, exhaustive presentation/recovery policy, diagnostics policy, documentation row, and focused tests together. Do not render diagnostic causes as ordinary UI copy.

## Pre-commit

Vite plus controls the pre-commit hook.

## Validation

`vp check`, `vp test run` and `vp run fallow` must be run after making any changes to check for issues. `vp check` covers typechecking, linting, formatting issues, all in one.

<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->
