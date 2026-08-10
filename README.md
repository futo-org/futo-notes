# FUTO Notes

FUTO Notes is an offline-first markdown notes app with optional E2EE sync.

## Sync Server

The sync server now lives in a separate repo:

<https://gitlab.futo.org/futo-notes/futo-notes-server> (clone to `~/Developer/futo-notes-server`)

For local development, start that server and connect FUTO Notes to its URL. The current POC stores opaque encrypted blobs; note content is encrypted in the client before upload.

## Development

Common commands from the monorepo root:

```bash
pnpm install
pnpm run dev
just tauri-dev
pnpm run build
```

New here? See [CONTRIBUTING.md](./CONTRIBUTING.md) for machine setup, then
[AGENTS.md](./AGENTS.md) for architecture and conventions.

Run the focused repository architecture checks with `just arch-gate`. See
[Architecture gates](./docs/architecture-gates.md) for what each check enforces and how to fix a
failure.

## Testing on Linux over Tailscale

Suites that do not need macOS run on a Linux box (`just remote-check`, `just remote-rust`,
`just remote-sync`, `just remote-android`, `just remote-doctor`), keeping the Mac free for Xcode and
the WKWebView desktop app. macOS-only recipes are refused by name. Desktop FUTO Notes runs on
WebKitGTK there and WKWebView on macOS, so paint, compositing and timing are **not** covered by a
remote run — see [Remote testing](./docs/remote-testing.md) for the exact boundary.
