# Automation Loop

Use this when iterating on built-in smart automations against the canonical vault without touching the source notes.

## Command

```bash
pnpm run automation:loop -- --source ~/Documents/demo-vault-backup
```

Optional flags:

```bash
--output-root <path>   # Default: .tmp/automation-loop
--models-path <path>   # Default: data/models
--plugin <id>          # Repeat to run a subset of built-in plugins
```

## What It Does

1. Copies the source vault into a timestamped temp run directory.
2. Bootstraps the copied vault into an isolated temp server DB.
3. Runs the built-in automations through the real server plugin routes.
4. Leaves the mutated copied vault in place for inspection.
5. Writes a diff and structured run artifacts.

The source vault is never modified.

## Artifacts

Each run creates a directory under `.tmp/automation-loop/` with:

- `vault/`: the copied vault after automations run
- `diff.patch`: diff between source vault and copied vault
- `summary.txt`: short text summary
- `report.json`: machine-readable run summary
- `runs/<plugin-id>.json`: full run detail payload for each plugin

## How To Review

Open `summary.txt` first, then inspect `diff.patch`, then read the per-plugin JSON files under `runs/` if a transform looks wrong or a plugin failed.

If a plugin fails because the model is unavailable, the run directory is still preserved.
