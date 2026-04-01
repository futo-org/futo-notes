# AGENTS.md - Stonefruit CLI

Rust CLI for deploying and managing the self-hosted sync server via Docker Compose.

**Stack**: Rust + Clap (arg parsing) + Ratatui (TUI) + reqwest (HTTP) + crossterm (terminal).

At the monorepo root, common CLI workflows are also wrapped as `just cli-build`, `just cli-build-all`, `just cli-test`, and `just cli-clean`.

## Commands

| Command | What it does |
|---|---|
| `setup` | Interactive TUI wizard: check Docker → configure port/path/password/semantic search → pull images → start containers → health check → set password |
| `settings` | Toggle semantic search on/off, regenerate docker-compose.yml, restart containers |
| `status` | Health check + dashboard metrics (optional auth for full stats) |
| `reset-password` | Reset server password using `.admin-token` from data dir |
| `update` | Pull latest server image and restart |
| `version` | Print CLI version |

`setup` supports non-interactive mode via flags: `--yes`, `--data-path`, `--port`, `--password`, `--password-stdin`, `--disable-semantic-search`.

## Architecture

- **`cli.rs`**: Clap command definitions and arg parsing.
- **`config.rs`**: `CliConfig` persistence (`.stonefruit-cli.json`). Loads, saves, infers config from existing docker-compose.yml. `write_managed_files()` writes both the config file and docker-compose.yml atomically.
- **`setup.rs`**: TUI wizard with 7 screens (Welcome → Docker check → Config → Semantic Search → Preview → Deploy → Success). Uses worker threads + mpsc channels for non-blocking deployment progress. Generates docker-compose.yml with optional Ollama sidecar for semantic search.
- **`settings.rs`**: Post-setup settings command. Reads existing config, toggles features, regenerates compose, restarts containers.
- **`docker.rs`**: Generates docker-compose.yml from `CliConfig`, manages `docker compose pull/up`. Includes Ollama service when semantic search is enabled. `pull_images_with_progress()` provides per-layer progress for the TUI. Defaults: port 3005, data path `./stonefruit-data`.
- **`server_api.rs`**: HTTP client (5s timeout) for `/health`, `/setup`, `/login`, `/dashboard/status`, `/admin/reset-password`.
- **`status.rs`**: Human-readable or JSON output. Auth optional.
- **`update.rs`**: Pulls latest image, detects changes, restarts if needed. Migrates legacy volume mount paths.
- **`reset_password.rs`**: Reads `.admin-token`, validates 8-char minimum.

## Building & Testing

```bash
just cli-build      # Release build → ./stonefruit
just cli-build-all  # Cross-compile: linux-amd64 + linux-arm64
just cli-test       # cargo test
just cli-clean      # Clean artifacts
```

Version override at compile time: `STONEFRUIT_VERSION=x.y.z just cli-build`

## Installation (end users)

```bash
curl -fsSL https://gitlab.futo.org/stonefruit/stonefruit/-/raw/main/apps/cli/install.sh | sh
```

Detects OS/arch, downloads from GitLab Package Registry, installs to `/usr/local/bin` (or `~/.local/bin`), auto-launches `stonefruit setup`.

## Verification (Required)

| What changed | Run |
|---|---|
| Any CLI code | `just cli-test` |
| Docker compose generation | Above + manual `stonefruit setup` smoke test |
| Server API interaction | Above + run against a real server instance |
