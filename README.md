# Stonefruit

Stonefruit is an offline-first markdown notes app with optional self-hosted sync.

## Quick Start: Dockerized Sync Server

The main setup path is the Stonefruit CLI.

The CLI installs and starts the Dockerized sync server for you.

```bash
curl -fsSL https://gitlab.futo.org/stonefruit/stonefruit/-/raw/main/apps/cli/install.sh | sh
```

The setup flow prompts for the notes/data directory and defaults to `./stonefruit-data`.
Use `http://localhost:3005` in Stonefruit and enter your password. On a fresh server, first-time setup completes automatically.

You can check the server later with:

```bash
stonefruit status
```

## Other Ways To Run It

### Docker Compose directly

If you do not want to use the CLI, run the published production Compose file. It pulls the pre-built server image from the GitLab Container Registry:

```bash
curl -O https://gitlab.futo.org/stonefruit/stonefruit/-/raw/main/apps/server/docker-compose.production.yml
docker compose -f docker-compose.production.yml up -d
```

The sync server listens on `http://localhost:3005`. To use a different host path for notes/data, set `STONEFRUIT_DATA_PATH`:

```bash
mkdir -p /srv/stonefruit-data
STONEFRUIT_DATA_PATH=/srv/stonefruit-data \
  docker compose -f docker-compose.production.yml up -d
```

## Development

Common commands from the monorepo root:

```bash
pnpm install
pnpm run dev
pnpm run tauri:dev
pnpm run build
```

If you are working from source, see [AGENTS.md](./AGENTS.md) and [apps/server/README.md](./apps/server/README.md).
