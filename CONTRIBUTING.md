# Contributing / Setup

New-hire setup for FUTO Notes. For *how the codebase is organized* and the
day-to-day rules, read [AGENTS.md](./AGENTS.md) next — this doc only gets your
machine ready.

## 1. Prerequisites

- **Node + pnpm** — the JS toolchain (`pnpm` is the package manager; `npx`/`npm`
  is not used here).
- **Rust** (stable) + `cargo` — for the Tauri backend and the shared crates.
- **[just](https://github.com/casey/just)** — every build/dev/test command lives
  in the [`justfile`](./justfile). Run `just` with no args to list recipes.
- Desktop (Linux): the usual Tauri/WebKitGTK system deps.
- Mobile (optional): Xcode + an iOS simulator for iOS; Android SDK + NDK +
  `cargo install cargo-ndk` for Android. See AGENTS.md → "Platform Build" and
  the `ANDROID_*` vars in `.env.example`.

## 2. First build

```bash
just install      # install all workspace dependencies
just tauri-dev    # run the desktop app (Wayland-first, port 5180)
just check        # lint + tests + build sanity — run this before pushing
```

> Dev/debug builds use the `com.futo.notes.dev` bundle id and a separate notes
> root (`~/Documents/fake-notes`), so they never touch a production install.
> Don't weaken that guard — see AGENTS.md → "Key Constraints".

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
- **Workflows** (`.claude/workflows/`) — multi-agent flows like
  `conformance-check` and `sync-adversarial`.
- **Shared settings** (`.claude/settings.json`) — a small project permission
  allowlist. Personal overrides go in `.claude/settings.local.json` (gitignored).

### MCP servers

To drive/debug the running app from Claude Code, copy the example config:

```bash
cp .mcp.json.example .mcp.json   # .mcp.json is gitignored
```

This wires up the Tauri MCP bridge (`@hypothesi/tauri-mcp-server`). See
AGENTS.md → "Browser Tools".

## 5. Sync server (for sync tests only)

The E2EE sync server is a **separate repo**:
<https://gitlab.futo.org/futo-notes/futo-notes-server>. Clone it to
`~/Developer/futo-notes-server` (or set `FUTO_NOTES_E2EE_SERVER_REPO` to wherever
you put it). It's only needed for `just test-cross-platform` and
`just test-mac-ios`; everything else runs without it.

## 6. Where to go next

- [AGENTS.md](./AGENTS.md) — architecture, where logic lives, key constraints,
  testing matrix.
- `docs/spec/` — behavioral source of truth, by surface.
- `just check` — the gate to pass before pushing.
