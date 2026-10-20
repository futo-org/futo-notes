## Ground rules (from AGENTS.md, restated because every workstream touches them)

- Read `apps/tauri/AGENTS.md` before Rust changes and `src/AGENTS.md` before Svelte changes.
  Each names the verification chain for its layer (§7.1, §7.4).
- Never weaken the dev/prod data split (M3). None of this touches vault paths; keep it that way.
- Fix every sibling occurrence (M17). Several workstreams have a copy in `scripts/tauri-dev.mjs`
  or a second CSS file. The steps name the ones found; grep for more.
- Update `docs/spec/` in the same MR as the behavior (M19). The three files touched are
  `docs/spec/nav.md` (§Desktop shell), `docs/spec/app.md` (§Display backend), and
  `docs/spec/settings.md` (Theme). Run `just check` before pushing; it includes the spec checks.
- Commit as `type(scope): imperative summary` with a `Verified:` line.
- Iterate with `just tauri-dev` (dev bundle id, fake vault, port 5180). Test the installed
  experience with `just deploy-rpm`, which is the only way to see the real `.desktop` file, icon,
  and launcher behavior. Neither one touches `~/Documents/futo-notes`.
