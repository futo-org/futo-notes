# Contributing / Setup

New-hire setup for FUTO Notes. For *how the codebase is organized* and the
day-to-day rules, read [AGENTS.md](./AGENTS.md) next — this doc only gets your
machine ready.

## 1. Prerequisites

- **Node + pnpm** — the JS toolchain (`pnpm` is the package manager; `npx`/`npm`
  is not used here). The exact version is pinned in [`.nvmrc`](./.nvmrc);
  [fnm](https://github.com/Schniz/fnm) reads it (`fnm use`), and every CI surface
  — Linux, macOS and Windows — installs that same version the same way.
- **Rust** (stable) + `cargo` — for the Tauri backend and the shared crates.
- **[just](https://github.com/casey/just)** — every build/dev/test command lives
  in the [`justfile`](./justfile). Run `just` with no args to list recipes.
- Desktop (Linux): the usual Tauri/WebKitGTK system deps.
- Mobile (optional): Xcode + an iOS simulator for iOS; Android SDK + NDK +
  `cargo install cargo-ndk` for Android. See AGENTS.md §2, the nested mobile
  `AGENTS.md` files, and the `ANDROID_*` vars in `.env.example`.

## 2. First build

```bash
just install      # install all workspace dependencies
just tauri-dev    # run the desktop app (Wayland-first, port 5180)
just check        # lint + tests + build sanity — run this before pushing
```

> Dev/debug builds isolate their notes from production. Desktop/iOS use
> `com.futo.notes.dev` and `fake-notes`; Android isolates package storage by
> application ID and uses a separate public device folder. Don't weaken those
> guards — see AGENTS.md M3.

## 3. Environment variables

None are needed to build and run the app. They gate specific workflows
(release tooling, Zulip, sync tests, mobile signing). See
[`.env.example`](./.env.example) for the full list with descriptions — copy the
ones you need into your shell profile (`~/.zshrc`/`~/.bashrc`) or `source` a
local `.env`.

## 4. Claude Code setup (optional but recommended)

This repo ships shared Claude Code config under `.claude/`:

- **Skills** (`.claude/skills/`) — `/bugfix`, `/release`, `/slow-review`,
  `/test-agent`, `/verify`, `/zulip`. Available automatically when you open the
  repo in Claude Code. Note `/release`, `/verify`, and `/zulip` need
  `GITLAB_TOKEN` / `ZULIP_API_KEY` (see step 3).
- **Workflows** (`.claude/workflows/`) — multi-agent flows like `sync-adversarial`.
- **Shared settings** (`.claude/settings.json`) — a small project permission
  allowlist. Personal overrides go in `.claude/settings.local.json` (gitignored).

### Third-party skills (optional)

`skills-lock.json` records the generic engineering skills we borrow from
`mattpocock/skills` (`/tdd`, `/research`, `/code-review`, `/wayfinder`, …). They
are **not vendored here** — an external installer populates the gitignored
`.agents/skills/`, and then `just skills-link` links them into `.claude/skills/`
for that checkout. Run it once per clone or worktree; skills it cannot find are
reported rather than linked.

Never commit those links: `.agents/` is gitignored, so a committed symlink into
it works only in the checkout that happens to have `.agents/` populated and
dangles in every fresh clone and `git worktree add`. `just check-agent-docs`
fails on one. The repo-side adapters these skills read — how they should consume
our domain docs, our issue tracker, and our triage labels — live in
`docs/agents/domain.md`, `docs/agents/issue-tracker.md`, and
`docs/agents/triage-labels.md`, and only apply when the matching skill is
installed.

### MCP servers

To drive/debug the running app from Claude Code, copy the example config:

```bash
cp .mcp.json.example .mcp.json   # .mcp.json is gitignored
```

This wires up the Tauri MCP bridge (`@hypothesi/tauri-mcp-server`). See
AGENTS.md §9; the driving playbook is the `/verify` skill's `references/desktop.md`.

## 5. Sync server (for sync tests only)

Nothing to set up. The E2EE sync server is a **separate repo**
(<https://gitlab.futo.org/futo-notes/futo-notes-server>) that publishes a static
Go binary per release; `just test-cross-platform` and `just qa-server` download
the release pinned in `scripts/sync-server-pin.json` on first use (~15 MB,
cached in `~/.cache/futo-notes`) and give each server its own SQLite database.
No checkout, no Postgres, no Docker.

To run an unreleased server change instead, point
`FUTO_NOTES_E2EE_SERVER_REPO` at your checkout — it is built with `go build` —
or `FUTO_NOTES_E2EE_SERVER_BIN` at a binary you already have.

## 6. Where to go next

- [AGENTS.md](./AGENTS.md) — architecture, where logic lives, key constraints,
  testing matrix.
- `docs/spec/` — behavioral source of truth, by surface.
- `just check` — the gate to pass before pushing.
