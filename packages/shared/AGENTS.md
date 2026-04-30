# AGENTS.md - @futo-notes/shared

Shared TypeScript types and utilities consumed by both the FUTO Notes client and the external E2EE sync server (`/home/justin/Developer/futo-notes-server`).

From the monorepo root, prefer `just test-shared` for shared-package coverage, then broaden to `just test` or `just check` when consumer integration risk is higher.

- Consumed as TypeScript source — no build step
- Path alias: `@futo-notes/shared` → `packages/shared/src` (configured in root `tsconfig.json`)

## Contents

- **`filename.ts`**: Title sanitization (`sanitizeTitle`, `validateTitle`, `isValidTitle`), forbidden character rules, max length constants
- **`sync.ts`**: Auth protocol types (`SetupRequest`, `LoginRequest`, `LoginResponse`, `ChangePasswordRequest`, etc.), image extension validation (`IMAGE_EXTENSIONS`, `isImageFilename`)
- **`tags.ts`**: Tag parsing and validation (`extractTags`, `extractHeaderTagBlock`, `TAG_REGEX`, `MAX_TAG_LENGTH`)

## Verification (Required)

- Changes here affect both the client and the sync server. Run `just test-shared`, then verify affected consumers.
- If filename or tag logic changes, include a regression check exercising real consumer behavior (unit tests in client or server).
