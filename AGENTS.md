# AGENTS.md

## Project Overview

Instaext is a Chrome/Firefox browser extension (Manifest V3) for downloading Instagram posts, reels, stories, and highlights.

## Commands

```bash
# Build extension (outputs to extension/)
bun run build

# Dev rebuild on file changes
bun run dev

# Test
bun run test          # single run
bun run test:watch   # watch mode

# Lint & Format
bun run lint         # eslint
bun run lint:fix     # eslint --fix
bun run format      # prettier --write
bun run format:check
```

## Architecture

- `templates/` - source HTML (popup.html, background.html)
- `src/` - React source code (App.tsx, popup.tsx, background.ts)
- `extension/` - **built extension output** (load this in browser)
- Vite root is `templates/`, builds to `extension/`
- Post-build script (`scripts/postbuild.mjs`) copies manifest.json, icons, and generates runtime files

## Testing

- Vitest with jsdom environment
- Test files: `src/**/*.test.ts`, `src/**/*.test.tsx`
- Test setup: `src/test/setup.ts`

## Important Quirks

- No `typecheck` command available
- Always run `bun run build` before testing in browser - builds to `extension/` directory
- Vite config root is `templates/` not project root