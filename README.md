# Stonefruit

Stonefruit is an offline-first markdown notes app with optional self-hosted sync.

## Install

Download the latest build for your platform from the releases page:

https://gitlab.futo.org/stonefruit/stonefruit/-/releases

## Run the sync server

### Recommended: Stonefruit CLI

The CLI installs and starts the Dockerized sync server for you.

```bash
curl -fsSL https://gitlab.futo.org/stonefruit/stonefruit/-/raw/main/apps/cli/install.sh | sh
stonefruit setup
```

You can check the server later with:

```bash
stonefruit status
```

### Run Docker directly

If you do not want to use the CLI, run the published Docker Compose file:

```bash
curl -O https://gitlab.futo.org/stonefruit/stonefruit/-/raw/main/apps/server/docker-compose.production.yml
docker compose -f docker-compose.production.yml up -d
```

The sync server listens on `http://localhost:3005` and stores its data in a Docker volume.

In Stonefruit, set the sync server URL to `http://localhost:3005` and enter a password. On a fresh server, the app will complete first-time setup automatically.

## Development

If you are working from source, see [AGENTS.md](./AGENTS.md) and [apps/server/README.md](./apps/server/README.md).
