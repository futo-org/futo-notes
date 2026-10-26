# CLI — Spec

`futo-notes` is a terminal client for one Markdown vault on a headless Linux machine, syncing
with a self-hosted server in password mode. Every line in this file is about the CLI unless it
names shared engine behavior.

> **Gap:** Not built. There is no `apps/cli` on main; every line below is a requirement for the first version.

## Scope

- The CLI runs with no graphical session, no FUTO Notes app, no Tauri runtime, no WebView, and no Node.js.
- Local note commands need no account and no network.
- The first version supports Linux x86_64 only; it is built and tested there and nowhere else.
- Sync uses the existing server protocol and encryption formats in password mode; the CLI needs no server changes.
- The CLI must not be pointed at a vault that a desktop or mobile app also has open. Its lock coordinates CLI processes only; the engine's write locks are per-process and do not see each other across processes.
- Out of scope for the first version: hosted (FUTO account) sign-in, OS keychain storage, continuous or watch-mode sync, note and folder deletion, more than one configured vault, macOS and Windows builds, and a terminal UI.

## Vault selection

- `init <path>` creates the directory if it is missing, records its canonical path as the CLI's vault, and contacts no server.
- `init` on a directory that already holds notes registers it without renaming, rewriting, or migrating anything.
- `init` on the vault already configured changes nothing.
- `init` on a different path replaces the configured vault and clears the server and password command, so the new directory never syncs into the account until `auth login`.
- The CLI never seeds a welcome note and never runs the store's launch bootstrap or `.txt` migration; it opens the vault with `LocalNoteStore::new`. → `crates/futo-notes-store/src/bootstrap.rs`
- Every vault command uses the configured vault, or the path given with the global `--vault <path>` for that one command.
- With no configured vault and no `--vault`, vault commands fail and name `init`; the CLI never guesses a location, uses the working directory, or finds a GUI app's vault.
- A configured vault directory that no longer exists is an error; only `init` creates a vault directory.
- `--help` and `--version` need no vault, no password, and no network.
- Configuration is one versioned JSON file in the per-user config directory under `futo-notes-cli` (`futo-notes-cli-dev` for development builds), written atomically.
- Configuration holds the vault path, the server URL, and the password command. It never holds a password, session token, or vault key.
- A configuration file with a newer version than the CLI understands is an error, not something to rewrite.
- The search index lives in the per-user cache directory, keyed by the canonical vault path, never inside the vault, and is safe to delete.

## Commands

Global options, accepted before or after the command: `--vault <path>` and `--json`.

| Command | Behavior |
|---|---|
| `init <path>` | Configure the vault as above and print its canonical path. |
| `status` | Print the vault path, the server URL or "local only", and whether a password command is set. No network. |
| `auth login --server <url> [--password-command <cmd>]` | Sign in, record the server (and command), and run the first sync. |
| `auth logout` | Disconnect through the engine and remove the server and password command from configuration. |
| `list [--folder <folder>] [--limit <n>]` | Print note IDs in the engine's default order; `--folder` matches that exact folder, `--folder ''` the root. |
| `read <id>` | Print the note's exact bytes with nothing added. |
| `search <query> [--limit <n>]` | Run the shared search engine; default limit 20. |
| `create <id> (--body <text> \| --stdin)` | Create a note, never overwriting; print the ID the engine allocated. |
| `append <id> (--body <text> \| --stdin)` | Append the text verbatim to an existing note; print its ID. |
| `edit <id>` | Edit an existing note in `$VISUAL` / `$EDITOR` and save it back safely. |
| `rename <id> <new-title>` | Rename within the note's folder; print the final ID. |
| `move <id> --folder <folder>` | Move to a folder, creating it if needed; print the final ID. |
| `sync` | Run one complete sync cycle and exit. |

- An ID is the vault-relative note path with `/` separators and no `.md` suffix: `release checklist`, `work/release checklist`.
- The filename is the title. The CLI never prettifies a title, strips a suffix it guesses at, or matches an ID fuzzily.
- Path safety, filename sanitizing, collision allocation, folder rules, and backlink rewriting all come from the shared Rust rules; the CLI implements none of them.
- An absolute path, `..` traversal, or a symlink escape is rejected by the shared path check before anything is written.
- `read`, `append`, `edit`, `rename`, and `move` on a missing note fail with `note_not_found`; an existing empty note is valid.
- `create` and `append` take exactly one of `--body` or `--stdin`. `--stdin` reads to end of input as UTF-8; invalid UTF-8 fails before anything is written.
- An empty `create` body creates an empty note; an empty `append` changes nothing.
- `append` adds no separator or newline. It is one atomic read-and-write in the store, so two appends both land exactly once. → `LocalNoteStore::append` (to be added in `crates/futo-notes-store`)
- A note ID starting with `-` is accepted after `--`.
- `list` and `search` with no results succeed with empty output.
- `search` passes the query through unchanged, trailing whitespace included, so the shared prefix rule still applies. → [search.md](search.md)
- `search` waits for the index with one bounded call (`LocalNoteStore::wait_until_search_ready`); running out of time is an error, distinct from no matches.
- A successful write means it is committed to local disk. It says nothing about whether another device has it yet.
- `create` and `append` are not idempotent; a script must not blindly retry one after an unclear failure.

## Editing

- `edit` uses `$VISUAL`, then `$EDITOR`; with neither set it fails and says so, rather than guessing an editor.
- The editor command is split into words without a shell, and the temporary file path is passed as one argument.
- The temporary copy lives outside the vault, readable only by the user.
- No CLI lock is held while the editor is open.
- A nonzero editor exit leaves the note untouched and prints where the draft was kept.
- An unchanged draft writes nothing and leaves the note's modification time alone.
- Saving goes through the store's `flush_draft` with the body read before editing as its base. If the note changed meanwhile, the edit is kept as a conflict copy named by the engine, and the CLI prints its ID and exits nonzero with `draft_parked`. → `crates/futo-notes-store/src/flush.rs`
- If the save fails, the draft stays where it is and the CLI prints its path; after a successful save, the CLI deletes only the temporary files it created.

## Sign-in and passwords

- `auth login --server <url>` requires an `http://` or `https://` URL; plain HTTP stays allowed for self-hosted servers, as in the apps.
- Sign-in, collection choice, key derivation, and checkpoint handling all go through `SyncSession::connect`; the CLI does none of them itself. → `crates/futo-notes-sync/src/session/connect.rs`
- Signing in to an account that has no vault yet creates one protected by this password, as the apps do in password mode.
- `auth login` finishes with a full sync. If sign-in works and the sync fails, it exits nonzero, says which part failed, and keeps the configuration so `sync` can be retried.
- `auth login` for a vault already connected to a different server fails and names `auth logout`.
- Every `sync` signs in again with the password and keeps no session token between runs; the server expires each session after 7 days. → futo-notes-server `internal/auth/session.go`
- The server allows 10 sign-ins per 60 seconds, so a timer that syncs once a minute or less often stays under the limit.
- The password comes from the configured password command, or, with none set, a no-echo prompt on the controlling terminal.
- With no password command and no controlling terminal, as under a timer, `sync` fails at once with `auth_failed`; it never waits for input.
- The password command is split into words like the editor command and run without a shell. Stdin and stderr are inherited, so `pass` or `gpg` can prompt; stdout is the password, minus one trailing newline.
- A password command that exits nonzero, prints nothing, or runs longer than 60 seconds fails the command; its output is never printed.
- A wrong password fails as `auth_failed` and changes no local state.
- A password never appears in arguments, configuration, environment variables the CLI defines, logs, or output.
- `auth logout` calls `SyncSession::disconnect`, which keeps the ancestry records later syncs need, then clears the server and password command from configuration. It never deletes local notes or anything on the server.

## Sync

- `sync` obtains the password, connects, runs exactly one `SyncSession` cycle, and exits.
- Push-first ordering, conflict copies, merges, tombstones, attachments, checkpoints, and modification times are engine behavior. → [sync.md](sync.md)
- `sync` succeeds only on a clean cycle. Per-item failures, a checkpoint write failure, write refusals, and incomplete transfers exit nonzero with `sync_incomplete`, even when some work completed.
- Conflicts the engine resolved by making conflict copies do not fail the sync; the CLI reports how many it made.
- `sync` is safe to rerun: an interrupted or killed run resumes from the engine's saved checkpoint without losing notes or duplicating creates.
- Ctrl-C stops the current cycle through the session's shutdown, never by abandoning a half-written checkpoint.
- Unattended sync is a systemd timer or cron job running `futo-notes sync` with a password command configured; the CLI installs no service itself.

## Locking

- Each command that touches the vault holds one exclusive OS file lock for its whole run, keyed by the canonical vault path and stored in the per-user state directory, never in the vault.
- `edit` holds the lock only while reading the note and while saving it, never while the editor is open.
- A command waits up to 30 seconds for the lock, so a timer-driven `sync` and an interactive command wait for each other, then fails with `vault_busy`.
- The OS releases the lock when the process exits, including on a crash. The CLI never deletes a lock file or kills a process to take one over.

## Output

- Command data goes to stdout; prompts, progress, and warnings go to stderr. The CLI prints no color or terminal control sequences.
- `create`, `append`, `rename`, and `move` print the final note ID the engine reports.
- Note titles, folders, and bodies are printed as stored; `read` output is byte-for-byte.
- Human-facing text (help, prompts, errors) is a catalog entry in `languages/en.json`, per the repo-wide rule; command names, JSON keys, and error codes are untranslated identifiers. → `languages/README.md`
- `--json` prints one object on stdout. Success: `{"schemaVersion":1,"ok":true,"data":{…}}`. Failure: `{"schemaVersion":1,"ok":false,"error":{"code":"note_not_found","message":"…"}}`.
- `--json` never prompts; a command that would need to prompt fails with `auth_failed`.
- `read --json` returns `{id, content}`; `list --json` and `search --json` return `{notes: [{id, title, folder}]}`; writes return at least `{id}`; `sync --json` returns the engine's counts and never a token or key.
- Error codes: `invalid_argument`, `vault_not_configured`, `vault_missing`, `note_not_found`, `vault_busy`, `draft_parked`, `auth_failed`, `network_error`, `sync_incomplete`, `io_error`. Codes are chosen from typed engine outcomes, never by matching message text.
- Exit status is 0 on success, 2 for invalid usage, and 1 for every other failure.
- Schema version 1 may gain fields and error codes; removing or renaming one needs a new version.

## Where the code lives

- `apps/cli` is a thin shell: parse arguments, load configuration, take the lock, call the store or `SyncSession`, print the result. It has its own `AGENTS.md`.
- Note operations go through `LocalNoteStore`. The only engine change the first version needs is `LocalNoteStore::append`; append is never a CLI-side read followed by a write.
- Sync goes through `SyncSession`. The CLI keeps no sync state of its own.
- Building the CLI does not build Tauri, the editor bundle, or the mobile bindings.
- Root `just` recipes build, run, and test the CLI, and a CI job runs its tests and is listed in `release:gate.needs`.
- There is no CLI release artifact yet; `just build-cli` produces the Linux binary.

## Acceptance

Automated tests use scratch vaults and the server pinned in `scripts/sync-server-pin.json`; none touch a real vault or account.

| ID | Proof |
|---|---|
| CLI-01 | In a Linux container with no GUI, no Node.js, and no secret service, copy in the binary, `init`, create/list/read/search/edit notes, log in to the pinned server, and sync. |
| CLI-02 | With the network blocked and no password configured, every local command works. |
| CLI-03 | Log in to a server that already holds a vault with a note and an image; both arrive intact. Edit offline, sync, and a second client receives the exact bytes. |
| CLI-04 | With a password command set and stdin closed, `sync` runs unattended; with no command and no terminal, it fails at once with `auth_failed`. No password appears in config, output, or process arguments. |
| CLI-05 | A wrong password, a failing or slow password command, and an unreachable server each fail with a distinct code and no local change. |
| CLI-06 | Empty bodies, Unicode titles, multi-line stdin, IDs starting with `-`, and `.md` inside an ID round-trip; invalid UTF-8 and traversal are rejected with nothing written. |
| CLI-07 | Two concurrent creates with the same ID keep both notes and print the allocated IDs; concurrent appends each land exactly once; a command run during a sync waits and then succeeds. |
| CLI-08 | `rename` and `move` rewrite backlinks and report collision-resolved IDs. |
| CLI-09 | With an editor open, change the note from another CLI process, save: both versions survive and the exit code is `draft_parked`. Also: unchanged draft, editor failure, failed save. |
| CLI-10 | Kill the CLI mid-sync, rerun: no note lost, no duplicate create. Ctrl-C ends a sync cleanly. |
| CLI-11 | Per-item upload and download failures and a checkpoint write failure make `sync` exit nonzero, keep local edits, and a later `sync` recovers. |
| CLI-12 | `auth logout` leaves note bytes untouched; logging in again does not bring back notes deleted elsewhere or lose edits made while logged out. |
| CLI-13 | Every command in `--json` mode prints one valid object and nothing else on stdout. |
| CLI-14 | Removing the vault directory makes commands fail without recreating it; a development build reads and writes only `futo-notes-cli-dev`. |
