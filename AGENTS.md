## Cursor Cloud specific instructions

### Overview

Excalidraw is a client-side whiteboard React app (monorepo). No databases or external services are required for local development. See `CLAUDE.md` for project structure and key commands.

### Running services

- **Dev server**: `yarn start` — starts Vite dev server on port `3001` (configured in `.env.development`).
- The dev server runs `yarn install` internally before Vite starts, so a separate install step is not strictly necessary when using `yarn start`, but the update script handles it for other workflows (tests, lint, etc.).

### Key commands (see `package.json` scripts for full list)

| Task | Command |
|---|---|
| Lint | `yarn test:code` |
| Format check | `yarn test:other` |
| Type check | `yarn test:typecheck` |
| Unit tests | `yarn test:app --watch=false` |
| Tests + snapshot update | `yarn test:update` |
| Auto-fix lint+format | `yarn fix` |

### Gotchas

- Tests emit `Error JSON parsing firebase config` to stderr in some app-level tests — this is benign and expected in environments without Firebase config env vars.
- The pre-commit hook in `.husky/pre-commit` is commented out (lint-staged is disabled), so no git hook will block commits.
- TypeScript 5.9.3 triggers a warning from `@typescript-eslint` about unsupported version — this is cosmetic and does not affect linting results.
