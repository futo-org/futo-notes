# CLAUDE.md - @futo-notes/shared

Shared TypeScript types and utilities used by both the client app and the server.

## What Goes Here

- Sync protocol types (request/response shapes, note metadata)
- Shared interfaces (NoteFile, sync state)
- Utility functions used by both client and server

## Usage

This package is consumed as TypeScript source (no build step). Other packages import directly:

```typescript
import { SomeType } from '@futo-notes/shared';
```

The root `tsconfig.json` has a path alias mapping `@futo-notes/shared` to `packages/shared/src`.

## Status

This package is scaffolded but empty. Types will be added as the sync server is implemented.
