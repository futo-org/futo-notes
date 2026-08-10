# Remote testing (Linux over Tailscale)

Everything in this repo that does **not** need macOS runs on a Linux box over Tailscale, so the Mac
stays free for the work only it can do: Xcode builds, the iOS simulator, and the WKWebView desktop
app.

```bash
just remote-doctor        # is the box ready? what needs a human with sudo?
just remote-check         # the pre-merge umbrella (== a Mac `just check`)
just remote-rust          # cargo test --workspace
just remote-sync          # cross-platform E2EE sync
just remote-android       # Rust .so + bindings + assembleDebug + JVM unit tests
just remote test-full     # any other portable recipe
just remote --rsync test-unit   # ...against your dirty working tree
```

The mechanism is `scripts/remote-test.mjs`; the recipes are thin wrappers. `node
scripts/remote-test.mjs --help` prints the full flag list.

## The default box

|              |                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| host         | `jfedora` (Tailscale MagicDNS), falling back to `100.90.52.106` if DNS does not answer                |
| user         | `justin`                                                                                              |
| capacity     | Fedora 44, x86_64, 32 cores, 125 GB RAM, KVM available                                                |
| CI worktree  | `~/ci/futo-main` — a detached `git worktree` of `~/Developer/futo-notes`, never that checkout itself  |
| cargo target | `~/.cache/futo-target-ci`, shared across runs so a warm workspace test is minutes not tens of minutes |

Override with `$FUTO_REMOTE_HOST` / `$FUTO_REMOTE_USER` (or `--host` / `--user`), and
`$FUTO_REMOTE_DIR` / `$FUTO_REMOTE_REPO` for the paths. `just remote-doctor` on a fresh box tells
you what is missing and prints the exact commands for anything needing root, so a second Linux box
is cheap to add.

Every invocation re-establishes the environment, because `ssh host cmd` gets a non-interactive shell
that reads no profile: nvm is sourced (node is otherwise **absent from `PATH`**), `~/.local/bin` and
`~/.cargo/bin` are prepended, `ANDROID_NDK_HOME` is pinned, `CARGO_TARGET_DIR` is set, and a
repo-root `dist/` is created (M20 — `cargo build` needs it to exist).

Two environment details are load-bearing and were both learned the hard way:

- **`CI` is explicitly unset.** `cargo tauri build` maps its `--ci` flag to `$CI`, so an _empty_
  `CI` makes clap reject the build outright; a truthy one would also cap vitest to 4 workers and
  waste 28 of the box's 32 cores.
- **`CARGO_TARGET_DIR` is per-suite.** It normally points at the shared warm cache, but
  `test-cross-platform` (and `prepush`, which contains it) get `<worktree>/target` instead:
  `tests/lib/tauri-instance.mjs` resolves the debug binary as `<repoRoot>/target/debug/…`, and
  `tests/cross-platform-sync.mjs`'s `pgrep` cleanup deliberately only kills binaries under this
  repo's own `target/`. Relocating the target dir made the suite die with `ENOENT` _after_ a
  successful 52-second build. `REPO_LOCAL_TARGET_RECIPES` in `scripts/remote-test.mjs` is that
  exception list; teaching the shared harness to honour `CARGO_TARGET_DIR` would remove the need
  for it.

`ANDROID_NDK_HOME` is pinned to the `ndkVersion` in `apps/android/app/build.gradle.kts`, read from
the checkout rather than defaulting to "newest installed". A mismatch between the NDK AGP uses and
the one `cargo-ndk` builds the Rust `.so` with breaks NDK resolution and makes AGP _silently_ skip
stripping and debug-symbol extraction — see the comment on that `ndkVersion` line.

## What a Linux run does and does not prove

This is the whole judgement call, so it is stated once, plainly, and repeated by the tool at
runtime.

**Equivalent on Linux.** Rust (all crates), TypeScript type-checking and lint, the jsdom/vitest unit
suites, the editor package tests, the conformance fixtures, the architecture gates, the vite build,
and the E2EE sync protocol including the cross-platform harness's assertions about sync state and
files on disk. These are logic and data. The operating system is not a variable.

**Not equivalent on Linux.** Anything whose answer comes from the web engine. Desktop FUTO Notes uses
**WKWebView** on macOS and **WebKitGTK** on Linux — two different engines with different compositors,
paint scheduling and IME plumbing. A recent blank-frame regression on WKWebView could be neither
confirmed nor refuted by a Linux run. This is the same boundary as **M22** (Playwright/WebKit cannot
prove Windows WebView2): a passing run on the wrong engine is not evidence about the engine we ship.

`remote-test` encodes that boundary in three tiers rather than leaving it to be read:

1. **Refused** (exit 2, before any network call) — recipes that need Xcode, the iOS simulator or
   swift-format (`build-rust-ios`, `build-ios-native`, `test-ios-native`, `ios-native*`,
   `deploy-ios`, `lint-swift`, every `sim-*`), recipes whose _purpose_ is the shipped desktop engine
   (`test-desktop-smoke`, `perf-course`, `factory-*`), interactive dev/QA commands
   (`tauri-dev`, `test-headed`, `test-ui`, `android-drive`, …), recipes needing root
   (`deploy-deb`, `deploy-rpm`), and ones that manage the machine you are sitting at (`qa-claim`,
   `qa-release`, `qa-clone-target` — the last is APFS `cp -Rc`). Refusal resolves the justfile's
   aliases first, so `just remote in` is refused as `ios-native`.
2. **Caveated** — allowed, but a `CAVEAT:` line names what a green run leaves uncovered, and the
   footer repeats it. `test-e2e*` and `test-markdown-spec` (Linux Chromium/WebKit builds),
   `test-cross-platform` (WebKitGTK Tauri app), and `prepush`.
3. **Clean** — everything else, including `check`. `just check` is tsc, eslint, prettier,
   svelte-check, vitest under jsdom, the arch gates, the Rust conformance tests and a vite build.
   None of them start a real web engine, so a remote `check` is a true substitute for a Mac `check`
   and carries no caveat. `prepush` is caveated rather than refused precisely because it _adds_ the
   full Playwright suite and cross-platform sync on top of `check`: nothing in it is macOS-only, but
   a green remote `prepush` is not a licence to skip the Mac.

Unknown recipe names are refused too — the name is validated against the local justfile, so a typo
fails instantly instead of after an ssh round trip.

## Getting the code there

Default (**git mode**): the current commit must already be on a remote branch. The box does
`git fetch` + `git checkout --force --detach <sha>` in `~/ci/futo-main`. Same semantics as CI, and the
result is attributable to a sha. If the working tree is dirty, git mode prints a warning naming how
many changes will **not** be tested.

**`--rsync` mode**, for iterating: the working tree is pushed as-is, excluding `node_modules`,
`target`, `dist`, `.git`, `test-screenshots` and the other generated directories. Tracked-file edits
land; a later git-mode run resets them, though untracked files you rsynced over stay until removed.

Either way the header and the PASS/FAIL footer print `host=`, `mode=` and `sha=`, because the failure
this tool invites is trusting a stale remote checkout.

`pnpm install` runs only when `pnpm-lock.yaml`'s hash differs from the stamp of the last run (or
`node_modules` is absent) — 40 seconds most runs do not need, and skipping it _silently_ would be
worse than paying it.

## Exit status and the lock

The remote status is propagated verbatim and never piped (**M11** — no silent green). Two codes mean
the suite never ran: **2** refused, **75** the remote worktree was locked.

Runs take an exclusive lock on the remote worktree (`~/ci/futo-main.lock`, released by a shell trap
on `EXIT INT TERM HUP`). Two people targeting the same box would otherwise `git checkout` under each
other, and `test:cross-platform` has no per-worktree isolation at all — it uses the box-global
Postgres and a fixed server-port counter starting at 4000 (a known papercut). On a dedicated box
that lack of isolation is fine _because_ the lock makes runs serial. A blocked run reports who holds
the lock, from which machine and worktree, since when, and for which recipe; `--force-lock` breaks it
deliberately. Anyone who bypasses `remote-test` and ssh's in by hand bypasses the lock too.

## Android

Compile and JVM-unit legs (`just remote-android`) belong here now: 32 cores build the four-ABI Rust
`.so` far faster than the Mac, and nothing about them needs macOS.

Interactive Android **device QA** should also move here eventually — `/dev/kvm` makes the box's
emulators dramatically faster than the Mac's, where x86 images are emulated. It has not moved yet
because the QA tooling assumes a _local_ `adb`: `just qa-claim`, `just android-drive` and
`just cdp-forward` all talk to a device on the machine running them, and `adb forward` is
machine-global. Wiring that up (an adb server reachable over the tailnet, or running the drive
scripts on the box) is the natural follow-up, and the payoff is large. Until then, keep device QA on
the Mac and use the box for build + unit legs.

## Known gaps

- `just remote-android`'s instrumentation and storage legs (`test-android-native-ui`,
  `test-android-storage`) need an emulator booted on the box; nothing here boots one yet.
- The box has no display, so a suite that needs one must go in the refused tier, not be "fixed" with
  a virtual framebuffer that then reports different compositing behaviour than either shipped
  engine.
