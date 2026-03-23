# AGENTS.md - Stonefruit CLI

Rust CLI for deploying and managing the self-hosted sync server via Docker Compose.

**Stack**: Rust + Clap (arg parsing) + Ratatui (TUI) + reqwest (HTTP) + crossterm (terminal).

## Commands

| Command | What it does |
|---|---|
| `setup` | Interactive TUI wizard: check Docker → configure port/path/password → pull image → start container → health check → set password |
| `status` | Health check + dashboard metrics (optional auth for full stats) |
| `reset-password` | Reset server password using `.admin-token` from data dir |
| `version` | Print CLI version |

`setup` also supports non-interactive mode via flags: `--yes`, `--data-path`, `--port`, `--password`, `--password-stdin`.

## Architecture

- **`cli.rs`**: Clap command definitions and arg parsing.
- **`setup.rs`** (~900 lines): TUI wizard with 6 screens (Welcome → Docker check → Config → Preview → Deploy → Success). Uses worker threads + mpsc channels for non-blocking deployment progress.
- **`docker.rs`**: Generates docker-compose.yml from config, calls `docker compose pull` and `up -d`. Defaults: port 3005, data path `./stonefruit-data`.
- **`server_api.rs`**: HTTP client (5s timeout) for `/health`, `/setup`, `/login`, `/dashboard/status`, `/admin/reset-password`.
- **`status.rs`**: Human-readable or JSON output. Auth optional.
- **`reset_password.rs`**: Reads `.admin-token`, validates 8-char minimum.

## Building & Testing

```bash
cd apps/cli
make build          # Release build → ./stonefruit
make build-all      # Cross-compile: linux-amd64 + linux-arm64
make test           # cargo test
make clean          # Clean artifacts
```

Version override at compile time: `STONEFRUIT_VERSION=x.y.z make build`

## Installation (end users)

```bash
curl -fsSL https://gitlab.futo.org/stonefruit/stonefruit/-/raw/main/apps/cli/install.sh | sh
```

Detects OS/arch, downloads from GitLab Package Registry, installs to `/usr/local/bin` (or `~/.local/bin`), auto-launches `stonefruit setup`.

## Verification (Required)

| What changed | Run |
|---|---|
| Any CLI code | `make test` in `apps/cli/` |
| Docker compose generation | Above + manual `stonefruit setup` smoke test |
| Server API interaction | Above + run against a real server instance |
