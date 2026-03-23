# E2E Demo Checklist

Use this flow when the user wants a working desktop demo end-to-end.

## Principles

- Treat the app as a product surface, not just a codebase. If the request implies "when I launch Stonefruit, it should already work," then set up the runtime state needed to make that true.
- Prefer an isolated environment over touching production-like state, but do not block on ideal packaging.
- Do not hand off operational steps like "now you should sync" if you can do them yourself.

## Steps

1. Implement the product change itself.
2. Identify the real launch target the user will use.
   Usually the installed `Stonefruit` desktop entry / `futo-notes-tauri`.
3. Point the app at the intended notes directory.
   On desktop this may mean checking `~/.local/share/com.futo.notes/notes-dir-override.json`.
4. Prepare the notes directory.
   For disposable demo backups, remove stale non-`.md` app-state/artifact files before reseeding.
5. Start an isolated server with its own DB/data path and unique port.
   Prefer Docker when available. If Docker is missing, use a separate local process or `systemd-run --user`.
6. Set up auth and seed the notes.
   If UI automation is unnecessary, use the real sync API directly instead of manually clicking through the client.
7. Build embeddings / search artifacts and verify they finished.
   Confirm `/health`, `/search/status`, and `/search/capabilities` report a completed run with a real `artifact_hash`.
8. Write or download the local client state the desktop app actually reads.
   This commonly includes `.preferences.json`, `.sync-state-v1.json`, `.supersearch-state.json`, `.supersearch-manifest.json`, and `.supersearch-vectors.bin` in the active notes dir.
9. Build and deploy the desktop binary the launcher should open.
   If `/usr/bin` is not writable, use a user-level wrapper in `~/.local/bin` plus a user desktop entry override in `~/.local/share/applications/`.
10. Eliminate launch-path ambiguity.
    Kill stale running app instances if single-instance behavior would redirect the launcher to the wrong binary.
11. Verify by launching the app the same way the user will.
    Use `gtk-launch Stonefruit` or the real desktop entry path, then confirm the expected binary/process starts.
12. Leave the environment in a reusable state.
    If the isolated server needs to keep running for the demo, keep it alive as a user service and document where it is.

## Desktop Demo Notes

- On Tauri desktop, the app reads its operational state from the current notes directory, not just from repo files.
- For semantic graph / supersearch work, verify both server-side indexing and local artifact presence.
- If you need to inspect graph clustering quality, build a script that runs against the real vault data rather than guessing from heuristics in the UI.
- When verification reveals that the UX is weak, continue tuning and rechecking the real output. Do not stop at "build passes" if the visible experience is still poor.
