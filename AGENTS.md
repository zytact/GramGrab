# AGENTS.md

## Project Overview

GramGrab is a Chrome/Firefox browser extension (Manifest V3) for downloading Instagram media.

## Build Commands

```bash
bun run build           # chromium + firefox (extension/chromium/, extension/firefox/)
bun run build:chromium  # BROWSER=chromium vite build + postbuild
bun run build:firefox   # BROWSER=firefox vite build + postbuild

bun run dev             # chromium watch (alias for dev:chromium)
bun run dev:firefox     # firefox watch

bun run lint            # eslint .
bun run lint:fix        # eslint --fix
bun run format          # prettier --write
bun run format:check
bun run typecheck       # tsc --noEmit

bun run test
bun run test:watch
bun run package:firefox # build:firefox + XPI packaging
bun run package:chromium
```

## Verification Order

Run linting and typecheck together before committing; test separately.

## Architecture

- **Vite root**: `templates/` (not project root). `popup.html` is the entry.
- **Background worker**: `src/background.ts` — bundled directly as `js/background.js` (no HTML wrapper).
- **Popup UI**: `src/App.tsx` rendered inside `popup.html`.
- **Output**: `extension/chromium/` or `extension/firefox/` depending on `BROWSER` env.
- **Post-build** (`scripts/postbuild.mjs`): generates per-browser `manifest.json`, copies icons, writes stub polyfill files.

## TypeScript Notes

- `tsconfig.json` uses `moduleResolution: bundler` and `verbatimModuleSyntax: true` — use `.js` extensions in `import` statements.
- `noUncheckedIndexedAccess: true` is enabled — access results may be `undefined`.
- Circular dependency warnings from Rollup are suppressed in Vite config (`CIRCULAR_DEPENDENCY` code is ignored).

## Testing

- Vitest with `jsdom`.
- Test files: `src/**/*.test.ts`, `src/**/*.test.tsx`.
- Setup: `src/test/setup.ts`.

## Pre-commit

- `bun run lint-staged` (eslint --fix + prettier --write on staged `.ts/.tsx/.js/.mjs` files).
