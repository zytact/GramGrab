# AGENTS.md

## Project Overview

Instaext is a Chrome/Firefox browser extension (Manifest V3) for downloading Instagram media.

## Commands

```bash
# Build (both targets -> extension/chromium, extension/firefox)
bun run build
bun run build:chromium
bun run build:firefox

# Dev watch (per-target)
bun run dev            # chromium
bun run dev:firefox

# Test
bun run test
bun run test:watch

# Lint & Format
bun run typecheck
bun run lint
bun run lint:fix
bun run format
bun run format:check

# Package Firefox XPI
bun run package:firefox
```

## Architecture

- `templates/` - Vite root (popup.html)
- `src/` - React + background worker source (App.tsx, popup.tsx, background.ts)
- `extension/<browser>/` - build output; load this in browser
- `BROWSER` env selects target; defaults to `chromium` if unset
- Post-build script (`scripts/postbuild.mjs`) generates per-browser `manifest.json` and copies icons

## Testing

- Vitest with `jsdom`
- Test files: `src/**/*.test.ts`, `src/**/*.test.tsx`
- Test setup: `src/test/setup.ts`

## Important Quirks

- Pre-commit runs `bun run lint-staged` (eslint --fix + prettier --write on staged files)
- Build output is per-browser; load `extension/chromium/` or `extension/firefox/`
