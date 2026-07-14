# futo-notes: suites, isolation, and consumers per scope

Repo-specific mechanics for the contract-rewrite phases. AGENTS.md §8 is the authoritative
testing map; this file organizes it by rewrite concern.

## Acceptance suites by layer (the contract gate)

Pick the highest-fidelity black-box suites that exercise the scope from outside:

| Scope layer | Black-box suites (the contract) | Fast layer |
|---|---|---|
| Sync crate (`futo-notes-sync`) | real-server `server_integration` + `sse_live` (isolated server, `--ignored`), `tests/cross-platform-sync.mjs` (30 scenarios, 2 real Tauri instances) | crate unit tests |
| Note domain (`futo-notes-model` / `-core`) | conformance fixtures (`just test-rust`, `pnpm run test:editor:minimal`) — TS↔Rust locked, regenerate via `tests/conformance/generate.mjs` | crate unit tests |
| Desktop TS/Svelte (`src/lib`, components) | Playwright (`just test-e2e` smoke, targeted specs), cross-platform harness when sync-adjacent | Vitest with `vi.mock('$lib/platform')` |
| Editor behavior (CM6) | `just test-markdown-spec` (YAML corpus), factory judge vs Obsidian | `src/lib/*.test.ts` |
| Tauri commands | e2e + desktop smoke (`just test-desktop-smoke`) | `_impl` unit tests in-file |
| Native shells | simulator/emulator QA (no iOS test target; Android JVM via `just test-android-native`) | push logic down to Rust instead |

## Isolated real server (never :3005 demo, never elitedesk)

Preferred: the repo's own per-worktree isolation — `just qa-server` (own port + own Postgres DB
for this worktree; `just qa-server-stop --drop` to tear down).

Manual alternative (what the sync rewrite used), from `~/Developer/futo-notes-server`:

```sh
docker compose up -d postgres
DATABASE_URL=postgres://futo_notes:futo_notes@localhost:5433/futo_notes bun run migrate
AUTH_MODE=dev PORT=3155 BLOB_DIR=/tmp/futo-notes-rewrite-acceptance \
DATABASE_URL=postgres://futo_notes:futo_notes@localhost:5433/futo_notes \
BLOB_GC_ENABLED=false bun src/index.ts
```

Then in the client worktree:

```sh
FUTO_TEST_SERVER=http://127.0.0.1:<port> \
  cargo test -p futo-notes-sync --test server_integration --test sse_live \
  -- --ignored --test-threads=1
node tests/cross-platform-sync.mjs
```

`FUTO_NOTES_DATA_DIR` isolates client data per worktree (M3 — never point a rewrite at real
notes in `~/Documents/futo-notes`).

## Consumer verification (Phase 4, G5)

The note domain and sync engine each have three consumers; a rewrite must verify all of them,
not just the crate:

```sh
cargo test -p <rewritten-crate>
cargo test -p futo-notes-ffi          # UniFFI facade (native iOS + Android)
cargo check -p futo-notes-tauri       # desktop shell
cargo clippy -p <crate> --all-targets --no-deps -- -D warnings
just build                            # tsc + vite, TS consumers
just arch-gate                        # reachability / platform-discipline / drift / debt-ratchet
```

FFI-visible changes: rebuild bindings (`just build-rust-ios` / `just build-rust-android`)
before judging native shells (M9). Whole umbrella before merge: `just check`.

## Repo-specific contract constraints

- **Conformance-locked pairs (§12)**: note rules exist in TS (`packages/editor`) AND Rust.
  A rewrite of either side must keep `tests/conformance/*` green bit-for-bit or change both
  sides + regenerate fixtures (§7.3). The fixtures ARE part of the contract.
- **Drift registry** (`just check-drift` via arch-gate): registered multi-copy concepts
  (path safety, notes-root split, image extensions, sort order, bridge handling) — a rewrite
  that touches one copy touches all, and the registry must stay consistent.
- **Debt ratchet** (`scripts/debt-ratchet.json`): if the rewrite reduces a counted debt,
  update the file in the same change; it only turns one way.
- **CRITICAL invariant sources for Phase 1**: `docs/spec/<area>.md` (behavior), AGENTS.md §6
  M1–M5 (data/render safety), and for sync specifically the invariant list in
  `docs/learnings/sync-rewrite.md` §2 (push-first, cursor caps, collection identity,
  ancestry demotion, tombstone safety, path triage, one cycle gate).
- **Watcher suppression**: any rewritten code that mutates the note tree registers filenames
  in the suppression map before writing.
- Stop-and-ask list (AGENTS.md §11) still applies mid-rewrite: hash/crypto functions,
  dev/prod root split, push-first ordering, `release:gate` needs, protocol shapes.
