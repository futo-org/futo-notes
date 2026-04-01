# AGENTS.md - @futo-notes/shared (Stonefruit)

Shared TypeScript types and utilities for both client and server.
Primary client runtime is Tauri v2 (plus web test/dev flows).

From the monorepo root, prefer `just test-shared` for shared-package coverage, then broaden to `just test` or `just check` when consumer integration risk is higher.

- Consumed as TypeScript source — no build step
- Path alias: `@futo-notes/shared` → `packages/shared/src` (configured in root `tsconfig.json`)
- Contains: shared auth/health/image helpers plus filename sanitization (`sanitizeTitle`, `validateTitle`)

## Verification (Required)

- Changes here must be verified in every affected consumer (web or mobile flows, and server flows when relevant).
- Run relevant tests in consuming apps (root unit or Playwright tests, plus server tests when sync or shared types are touched).
- If shared title or shared protocol helper logic changes, include at least one regression check that exercises real consumer behavior.
- Close only after affected consumers pass verification.
