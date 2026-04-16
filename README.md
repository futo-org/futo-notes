# Stonefruit

Stonefruit is an offline-first markdown notes app with optional E2EE sync.

## Sync Server

The sync server now lives in a separate repo:

`/home/justin/Developer/stonefruit-server`

For local development, start that server and connect Stonefruit to its URL. The current POC stores opaque encrypted blobs; note content is encrypted in the client before upload.

## Development

Common commands from the monorepo root:

```bash
pnpm install
pnpm run dev
pnpm run tauri:dev
pnpm run build
```

If you are working from source, see [AGENTS.md](./AGENTS.md).
