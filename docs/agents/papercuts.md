# Papercuts workflow

Papercuts are tooling and workflow friction that slows someone working in this repository: dead-end
tool calls, stale docs, broken `just` recipes, footgun configuration, or missing helpers. Product
bugs belong in code or the issue tracker; spec divergence is an inline `> **Gap:**` note.

File friction before moving on—do not stop the active task and do not fix-and-forget:

```bash
papercuts add "<what happened and what would have prevented it>" --tag <area>
```

If the command is missing, run `cargo install papercuts`. If installation fails, report that and
continue rather than sinking time into the reporting tool.

Severity is `minor` by default, `--severity major` for a time sink, and `--severity blocker` for a
hard wall. Tool failures accept `--cmd`, `--exit`, and `--stderr-file`; never attach raw environment
dumps. `papercuts schema` prints the full contract and `papercuts list --format md` the review digest.

The append-only `.papercuts.jsonl` log is committed with `merge=union`, so parallel worktrees can
record friction independently.

## Weekly sweep

A log that is only written to is a diary. Every Monday at 06:30 a scheduled headless Opus session
(`scripts/papercut-sweep/`, systemd user timer `futo-notes-papercut-sweep.timer` on the maintainer's
workstation) reads the open entries, fixes up to five that are tooling-, docs-, or recipe-shaped in
its own worktree, resolves them with a note saying what changed, and opens one draft MR. It never
merges and never touches a device. `just orient` shows the last run's date, status, and MR; the
operator manual is `scripts/papercut-sweep/README.md`.
