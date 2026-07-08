# AGENTS.md - @futo-notes/shared

Shared TypeScript types and utilities consumed by both the FUTO Notes client and the external E2EE sync server (`/home/justin/Developer/futo-notes-server`).

From the monorepo root, prefer `just test-shared` for shared-package coverage, then broaden to `just test` or `just check` when consumer integration risk is higher.

- Consumed as TypeScript source — no build step
- Path alias: `@futo-notes/shared` → `packages/shared/src` (configured in root `tsconfig.json`)

## Contents

- **`sync.ts`**: Auth protocol types (`SetupRequest`, `LoginRequest`, `LoginResponse`, `ChangePasswordRequest`, etc.), image extension validation (`IMAGE_EXTENSIONS`, `isImageFilename`). These are genuinely cross-process (client + server) and stay in TS.
- **`index.ts`**: Re-exports.

**The filename/tag rules do NOT live here anymore.** The canonical TS copies of the note rules
(`sanitizeTitle`, `validateTitle`, `extractTags`, `TAG_REGEX`, …) moved to
`packages/editor/src/{filename,tags,preview}.ts` and are imported by the app via the
`src/lib/rules.ts` shim. `futo-notes-model` (Rust) remains the canonical source; the TS copies are
held bit-for-bit in lockstep via `tests/conformance/*`. If you came here to change a title or tag
rule, edit `packages/editor` + the Rust crate and regenerate the fixtures — see root AGENTS.md
§7.3.

## Verification (Required)

- Changes here affect both the client and the sync server. Run `just test-shared`, then verify affected consumers.
- If filename or tag logic changes, include a regression check exercising real consumer behavior (unit tests in client or server).
