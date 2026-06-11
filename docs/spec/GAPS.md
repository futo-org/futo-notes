# Gap Inventory — GENERATED, do not edit

One line per inline `> **Gap:**` note in docs/spec/*.md (the source of
truth). Regenerate with `just spec-gaps`; `just spec-gaps-check` (part of
`just check`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

## sync.md

- [sync.md:22](sync.md#L22) — Tauri desktop still surfaces per-item counts after a manual sync — the Settings toast (`Synced: N uploaded, …`, SettingsScreen.svelte) and the coordinator status line (`Synced N notes`, syncManager.svelte.ts) both predate the "Sync complete"-only decision (2026-06-10).

_1 gaps._
