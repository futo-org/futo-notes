# Justfile notes

The justfile is the command authority (`just --list` shows every recipe with its one-line
doc comment). This file holds the longer rationale that used to sit above individual
recipes as multi-line comments — `just --list` only ever prints the single comment line
directly above a recipe, so anything longer was dead weight in the file that nobody saw
short of opening the source. One `##` section per recipe (or per cross-cutting topic).

## positional-arguments

`just` runs each unshebanged line via a fresh `sh -c`, and a variadic `*args` is joined
with spaces before `{{args}}` is interpolated — so the shell re-splits it. `just
android-drive tap 'Connect & Sync'` ran `node ... tap Connect` in the background and then
`Sync` (pc_9b7fd5dba746), and `just journal where --dir '/tmp/a b'` read `/tmp/a`. Recipes
that forward user-supplied text — a label, a test-name pattern, a path — pass `"$@"` for
that reason (enabled by `set positional-arguments := true` at the top of the file);
flag-only recipes still interpolate with `{{args}}`.

## rust-format / rust-format-check

The repo rule is that every command goes through `just`, but only the TypeScript side had
formatting recipes — so Rust changes had no sanctioned way to be formatted or checked.
rustfmt is pinned by `rust-toolchain.toml` (1.89.0), so both recipes are reproducible
across machines and CI.

## tauri-build

`NO_STRIP=true`: linuxdeploy ships an old `strip` that can't read `.relr.dyn` sections
emitted by newer binutils (Fedora 39+, Arch, etc.), which breaks AppImage bundling. CI runs
on `ubuntu:22.04` where stock strip matches, so this is local-only noise.

## build-ios-native / test-ios-native (simulator destination)

`build-ios-native` uses the *generic* simulator destination, which links both arm64 and
x86_64 — `build-rust-ios.sh` lipos a universal simulator slice so both resolve.
`test-ios-native` instead resolves a *concrete* `-destination "id=$SIM"`, which links only
ONE arm64 simulator, so the arm64-only FFI sim slice links without `EXCLUDED_ARCHS`. It
also ad-hoc signs so the app test host launches with its keychain entitlement (mirrors
`run.sh`).

## sim-boot (SHOW=1)

`sim-boot` deliberately does NOT foreground `Simulator.app` by default: `simctl` boots,
installs, launches and screenshots a headless device just fine, while activating the app
drags whoever is typing to another space (parallel QA sessions on one Mac). Pass `SHOW=1`
when a human needs to watch, or when measuring anything that awaits a frame — an occluded
window has its rendering suspended.

## sim-logs

The app logs mostly via `print()`, which `os_log` does NOT capture. For stdout, relaunch
with `xcrun simctl launch --console-pty booted com.futo.notes.dev`.

## emu-boot

Waits for the package service too, not just `boot_completed`: the property flips first,
and an `adb install` issued in that window fails with `cmd: Can't find service: package`.

## cdp-forward

Debug builds only; re-run after every app restart (the WebView pid changes). `adb forward`
host ports are machine-global, so the port is per-worktree (9330 + slot; override with
`$CDP_PORT`). `scripts/cdp-invoke.mjs` honors `$CDP_PORT`.

## prepush (--retries=1)

The local 30s Playwright test timeout (CI gets 90s) makes a ~250-test run flake on the odd
slow navigation/click; one retry absorbs those while a genuinely broken test still fails
both attempts. A test reported "flaky" because it only passed on retry is a real bug —
treat repeat offenders as such, not as environment noise.

## deploy-deb / deploy-rpm (pkill)

Both recipes stop every running FUTO Notes on the machine right before overwriting
`/usr/bin` — the only sanctioned pattern kill in this repo, and both exact lines are pinned
in `scripts/qa-input-safety-allowlist.json` so a third one anywhere else in the justfile
still fails `check-qa-input-safety`. This is a single-checkout install step, NOT a QA
cleanup template: on a multi-worktree machine, killing by process name takes out your
peers' apps too (AGENTS.md M25). QA cleanup uses `just qa-target kill`.

## deploy-rpm (dnf vs rpm)

Install does NOT route through dnf's version solver. `dnf reinstall` exits 0 while
installing NOTHING when the installed version differs from the file (it just prints
"Nothing to do."), so the old `reinstall || install` chain silently kept a stale binary on
disk for 20 days — and a suppressed stderr hid the one message that explained why.
`rpm -U --force` is unconditional: it replaces the installed package whatever its version.
First-time installs still go through dnf so dependencies get resolved.

The recipe then asserts the install actually landed by comparing the sha256 the package
records for the binary against what is now on disk — the package's own digest is the
reference, NOT `target/release/futo-notes-tauri` (the bundler strips the binary, so build
output legitimately differs from the packaged copy). This also catches the same-version
no-op case, where the version string alone would prove nothing.

## test-sync-integration

`server_integration.rs` holds two families that need two different server modes — the
sync scenarios need a DEV-mode server, the hosted ones a STAND-IN-mode server
(`STANDIN_MODE=true`) — so this starts both on this worktree's slot-derived ports, points
each family at its own, and stops both by PID. The hosted leg runs only when the resolved
server can do stand-in mode (`standinMode` in `scripts/sync-server-pin.json`, or
`FUTO_NOTES_E2EE_SERVER_STANDIN=1` with your own build); when it cannot, those scenarios
stay covered by the in-test stub (`cargo test -p futo-notes-sync --test hosted_setup`).

## chunk-census

Proves progressive open's one load-bearing claim: parsing a note in top-level chunks and
appending them produces the SAME document as parsing it whole (docs/plan/milkdown-transition.md
§5, issue #105). Drives the REAL editor.html over a corpus of real notes at the finest cut
granularity the planner allows, and exits non-zero on a single divergence. NOT in
`check`/CI — the corpus is real user notes and lives outside this repo. Committed result:
`docs/evidence/milkdown-chunk-census.md`. `--dump-divergences <path>` writes the offending
notes for triage (carries note TEXT, keep it out of the repo). `--serialize` runs the OTHER
equivalence claim over the same corpus/harness: `blockSerializer.ts`'s per-block cache must
match Milkdown's own serializer called directly.

## check-node-modules / _require-install / _require-node-modules

A fresh worktree has no `node_modules`, and the first JS recipe `check` reaches dies with
`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "tsx" not found` — an error that names a
binary, not the missing install (pc_40406aa84bc1). Not an auto-install: `check` is a gate,
and installing behind your back changes what it just verified. `check` deliberately does
NOT depend on `editor-deps`, even though every other recipe `editor-deps` guards does:
`editor-deps` self-installs (`pnpm install`) on a missing/stale `node_modules`, which is
exactly the behind-your-back mutation this forbids for a gate. All three guards only
refuse and tell you the command; they never run it for you. Three independent fixes for
this same papercut landed on parallel MR stacks (mr-298, mr-318, mr-320) — kept all three
rather than dropping any.

## release-notes-check

What App Store and Google Play users read. The tag pipeline submits both stores by itself,
so `release-notes/vX.Y.Z.md` is the only source of that copy and it must be on the TAGGED
commit — write it in the release MR. CI runs the same command in `check:release-notes`; run
it before tagging.

## qa-shot

No space switch and no stolen keyboard focus, so a parallel QA session cannot yank the
human out of whatever they are typing in: it captures the window where it lives, even on
another space (`screencapture -l <window id>`). Refuses anything `scripts/qa-target.mjs`
will not verify as a debug build of THIS worktree, since a window can show the user's real
vault (M24). With a live bridge, prefer its `capture_native_screenshot`; frame/paint probes
still need a genuinely VISIBLE window, which no capture tool can substitute for.

## qa-server (--standin)

Runs the futo-notes-server release pinned in `scripts/sync-server-pin.json`, downloaded on
first use — no checkout, no database server, no Docker. `--standin` starts it in hosted
stand-in test mode instead (Log in with FUTO and billing answered by in-process fakes) —
what the hosted QA stories under `docs/qa/` drive the native apps against. The pinned
release predates that mode, so today it needs `FUTO_NOTES_E2EE_SERVER_REPO=<server
checkout>` and `FUTO_NOTES_E2EE_SERVER_STANDIN=1`, and says so if it cannot run it.

## deploy-android (keystore gate, flavors)

`deploy-deb`/`deploy-rpm`/`deploy-ios` all install production builds; this is Android's
counterpart. Release signing needs `apps/android/keystore.properties` (gitignored) —
without it Gradle produces an unsigned APK that can't install, so the recipe refuses up
front and says what's missing instead of failing later at `adb install`. Defaults to the
`direct` flavor — what GitLab/Obtainium/F-Droid users get. `just deploy-android play`
installs the Google Play flavor's release build instead, which is the only way to put the
exact bytes Play will review on a device (Play itself is fed the AAB from CI, and an AAB
cannot be adb-installed). NOTE: this recipe is intentionally NOT in the "Removed recipes"
list below even though the 2026-09 usage audit flagged it as zero-invocation — it is
asserted live by `scripts/premerge-test-parity.test.mjs` ("builds both Android distribution
flavors..."), which requires `deploy-android flavor="direct":` to exist in the justfile.

## Removed recipes

Cut 2026-09 for zero invocations across both of Justin's machines in the prior 30 days
(shell history + agent transcripts) with only incidental repo references — see the
usage-audit findings in the MR that removed them. Their bodies are kept here verbatim so
the procedure isn't lost; run the commands directly instead of through `just`.

### tauri-prod

Desktop dev pointed at PRODUCTION endpoints instead of localhost — the one sanctioned
exception to "never call `cargo tauri`" directly (root `AGENTS.md` §1), because this mode
has no `just tauri-dev` equivalent.

```bash
pnpm run build
cd apps/tauri && WINIT_UNIX_BACKEND=wayland GDK_BACKEND=wayland WEBKIT_DISABLE_DMABUF_RENDERER=1 cargo tauri dev --config src-tauri/tauri.prod.conf.json
```

### updater-localdev

Local updater dry-run with stand-in keys (Linux/AppImage only; see `keys/README.md`):
`node scripts/release-build.mjs e2e`.

### audit

Dependency vulnerability scan (Rust + npm; needs network + `cargo-audit`):
`node scripts/audit.mjs [--fix]`. Also what CI's `test:audit` job runs directly, since the
pinned CI image has no `just`.

### gate-redproofs

Proves architecture gates fail for the violations they claim to catch — deliberately
manual, run when adding or changing a gate: `node scripts/gate-redproofs.mjs
--include-cargo`.

### remote / remote-check / remote-rust / remote-doctor / remote-android

Thin `just` wrappers around `scripts/remote-test.mjs`, which still does the work — only the
wrappers were removed (`remote-sync` is the one kept). Call the script directly:

```bash
node scripts/remote-test.mjs --doctor              # remote environment report
node scripts/remote-test.mjs <recipe>               # any other portable recipe
node scripts/remote-test.mjs check                  # the pre-merge umbrella
node scripts/remote-test.mjs test-rust-full          # the full Rust workspace
node scripts/remote-test.mjs build-android-native \
  && node scripts/remote-test.mjs test-android-native   # Android .so + bindings + JVM tests
```

`--rsync`/other flags go before the recipe name, same as before. See `docs/remote-testing.md`
for the full flag list and the macOS-only/interactive/local-machine refusal tiers.
