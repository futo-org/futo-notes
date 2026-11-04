# Platform traps (things that lie to you)

Named mistakes M21–M27 from AGENTS.md §6.E.

- **M21 — Synthetic input/stale screenshot.** DOM `click()` misses Svelte handlers; unfocused
  Android throttles frames; iOS 26 nav items evade a11y taps, and `axe gesture`/`axe tap` report
  success while doing nothing. Suspect the tool before the app, and **never record a spec gap from
  one tool's silence**; mechanics live in `/verify`'s `references/ios.md` + `references/android.md`.
- **M22 — Wrong browser.** Playwright cannot prove WebView2 or real iOS keyboard behavior. Use the
  Windows VM/device; after dependency changes, a blank editor usually means the bundle carries two
  copies of an editor library — duplicated `prosemirror-*` (or `@milkdown/*`) instances silently
  break the mounted view.
- **M23 — Updater signing order.** The detached `.sig` must be the LAST touch on artifact bytes —
  after patching/notarization/Authenticode. Read `docs/release/updater.md` and `keys/README.md`, and
  rehearse locally with `node scripts/release-build.mjs e2e`; localdev signatures must never verify
  in production.
- **M24 — QA input hit the production app.** OS-level input (AppleScript UI scripting, `cliclick`)
  goes to the FOCUSED window, and every build shares the binary name — so a name/PID lookup sent
  real keystrokes into the user's live vault. Resolve any desktop QA target ONLY through
  `scripts/qa-target.mjs`, and drive the webview bridge, never the window server.
- **M25 — Pattern kill across worktrees.** `pkill -f vite` / `pkill -f "cargo tauri dev"` reach every
  checkout on the machine, and fail silently as a wrong answer: the peer gets an orphan that still
  serves its bridge but never rebuilds, or a screenshot of a dead dev server instead of a test
  failure. Terminate by identity only — `just qa-target kill`, the PID/process group you started, or
  a port from `just ports` — never by process name. `just check-qa-input-safety` enforces it.
- **M26 — Untested platform branch.** A cfg-gated implementation whose tests are gated to
  the OTHER cfg ships to the only platform that runs it with nothing having executed it, and a
  green `just check` says nothing about it. github#48: the `cfg(not(unix))` vault filesystem
  answered "parent folder missing" with an I/O error instead of absence for three releases, so
  every note synced into a folder a Windows client did not have yet failed forever. A branch that
  needs no platform APIs to RUN (plain `std::fs`) gets compiled under `cfg(test)` everywhere and
  held to the shipped branch's rules — `crates/futo-notes-core/src/files/vault_fs/contract_tests.rs`
  stamps one rule set over both implementations.
- **M27 — Invisible characters through Write/Edit.** The file tools normalize exotic whitespace
  (U+0085, U+205F) to plain spaces, so a script whose map keys were those characters lost them and a
  `split('')` destroyed an 1100-line file. Write non-printable characters as ASCII escapes
  (`\u0085`), never literally.
