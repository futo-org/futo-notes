# AGENTS.md - @futo-notes/shared

Shared TypeScript types and utilities for both client and server.
Primary client runtime is Tauri v2 (plus web test/dev flows).

- Consumed as TypeScript source — no build step
- Path alias: `@futo-notes/shared` → `packages/shared/src` (configured in root `tsconfig.json`)
- Contains: sync protocol types, `NoteSyncMeta`, filename sanitization (`sanitizeTitle`, `validateTitle`)

## Verification (Required)

- Changes here must be verified in every affected consumer (web or mobile flows, and server flows when relevant).
- Run relevant tests in consuming apps (root unit or Playwright tests, plus server tests when sync or shared types are touched).
- If shared sync or title logic changes, include at least one regression check that exercises real consumer behavior.
- Close only after affected consumers pass verification.
