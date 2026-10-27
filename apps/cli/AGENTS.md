# AGENTS.md — `futo-notes` CLI

Root `AGENTS.md` and `docs/spec/cli.md` apply; the spec is the contract (commands, JSON shape,
error codes, exit status). This crate builds the `futo-notes` binary for headless Linux. It is a
**shell**: note rules live in `futo-notes-store`, sync in `futo-notes-sync`, paths and crypto in
`futo-notes-core`. Nothing here decides a note rule or a sync rule.

## Layout

- **`main.rs`**: parse, build the `Context`, dispatch, turn a `CliError` into its exit status.
- **`cli.rs`**: the clap grammar, built at runtime so every help line is a catalog message.
- **`commands/`**: `notes.rs` (list/read/search/create/append/rename/move), `edit.rs`, `init.rs`,
  `status.rs`, `auth.rs` (login/logout), `sync.rs` (one cycle).
- **`config.rs`** (one vault, server, password command — never a secret), **`vault.rs`**
  (selection), **`lock.rs`** (the CLI-wide vault lock), **`password.rs`** (command or tty prompt).
- **`error.rs`**, **`output.rs`**, **`i18n.rs`**: error codes, stdout/stderr/JSON rules, the
  `languages/en.json` accessor.

## Rules that are easy to break here

- **Every human string is a catalog entry** (`cli.*` in `languages/en.json`);
  `i18n::tests::every_literal_catalog_path_exists` fails on a missing path.
- **Never bootstrap.** `LocalNoteStore::new` and the workflows only.
- **Never read-then-write.** A two-step note change belongs in the store as one workflow (why
  `LocalNoteStore::append` exists).
- **The lock is CLI-only.** The engine's write locks are per-process, so the CLI must not share a
  vault with a running app; that is a documented limit, not something to paper over here.
- **No `println!`/`eprintln!`** (workspace lint): write through `output.rs`, which ignores a
  closed stream instead of panicking.
- **Debug builds use `futo-notes-cli-dev`** for config, cache, and lock directories. Never weaken
  that split. `FUTO_NOTES_CLI_TEST_PASSWORD_DEADLINE_MS` is honored by debug builds only.

## Testing

| What changed | Run |
|---|---|
| Anything in this crate | `just test-cli` (unit + `tests/local.rs` + `tests/server.rs` against the pinned server) |
| A store/sync/core workflow the CLI calls | that crate's own chain + `just test-cli` |
| Release binary | `just build-cli` (this machine), or `just build-cli-static` (any distro; needs musl-tools) |
| `build:cli:linux` (manual CI download) | rehearse its script in its pinned image before pushing |

Tests give every process its own `HOME`, `XDG_*` directories, and `TMPDIR`, start it with no
controlling terminal (`setsid`), and clear `VISUAL`/`EDITOR`, so no test can touch real settings,
prompt, or open an editor. `tests/server.rs` is `#[ignore]`d in a plain `cargo test`; CI runs it in
`test:rust:workspace`.
