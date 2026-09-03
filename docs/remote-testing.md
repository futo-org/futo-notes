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

|              |                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------- |
| host         | `jfedora` (Tailscale MagicDNS), falling back to `100.90.52.106` if DNS does not answer                            |
| user         | `justin`                                                                                                          |
| capacity     | Fedora 44, x86_64, 32 cores, 125 GB RAM, KVM available                                                            |
| CI worktree  | `~/ci/futo-main` — a detached `git worktree` of `~/Developer/futo-notes`, never that checkout itself              |
| cargo target | `~/ci/futo-main/target` — repo-local and warm across runs; `CARGO_TARGET_DIR` is deliberately NOT set (see below) |

Override with `$FUTO_REMOTE_HOST` / `$FUTO_REMOTE_USER` (or `--host` / `--user`), and
`$FUTO_REMOTE_DIR` / `$FUTO_REMOTE_REPO` for the paths. `just remote-doctor` on a fresh box tells
you what is missing and prints the exact commands for anything needing root, so a second Linux box
is cheap to add.

Every invocation re-establishes the environment, because `ssh host cmd` gets a non-interactive shell
that reads no profile: the fnm environment is loaded (node is otherwise **absent from `PATH`**), and
the exact version in `.nvmrc` is activated once the worktree is checked out. The box needs `fnm`
installed once — `just remote-doctor` reports it as required and prints the command. `~/.local/bin` and
`~/.cargo/bin` are prepended (plus `~/.bun/bin` — the E2EE sync test server is a bun project),
`ANDROID_NDK_HOME` is pinned, and a repo-root `dist/` is created (M20 — `cargo build` needs it to
exist).

Two environment variables are deliberately **cleared**, and both lessons cost a debugging cycle:

- **`CI`.** `cargo tauri build` maps its `--ci` flag to `$CI`, so an _empty_ `CI` makes clap reject
  the build outright ("a value is required for `--ci`"); a truthy one would cap vitest to 4 workers
  and waste 28 of the box's 32 cores.
- **`CARGO_TARGET_DIR`.** Relocating it to a shared cache directory broke two suites that reasonably
  assume the repo-local `target/`, in two different ways:
  `tests/lib/tauri-instance.mjs` resolves the debug binary as `<repoRoot>/target/debug/…` (and
  `cross-platform-sync.mjs`'s `pgrep` cleanup only kills binaries under it — a deliberate guard), so
  `remote-sync` died with `ENOENT` _after_ an 84-second build; and
  `scripts/ci-cargo-cache-freshness.mjs` reads `$CARGO_TARGET_DIR`, so its unit tests inherited ours,
  inspected a directory that did not exist, concluded "no restored cache" and exited 0 where they
  assert 1 — five `remote-check` failures that do not reproduce on the Mac.
  The remote worktree's own `target/` is already a persistent warm cache: git mode never touches it
  and `--rsync` excludes it. Honouring what the repo assumes is cheaper than auditing every consumer
  of that variable.

And one is pinned rather than cleared: **`JAVA_HOME`**. Fedora's default JDK is 25, which the pinned
Gradle 8.14.3 cannot run on — and it says so only as `What went wrong: 25.0.4`, naming neither Java
nor the constraint, _after_ the Rust `.so` and Kotlin bindings have built fine. `remote-test` picks
the first installed JDK 21 (then 17) from `GRADLE_JDK_CANDIDATES`; override with
`$FUTO_REMOTE_JAVA_HOME`, and `just remote-doctor` reports the selection.

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
   (`test-desktop-smoke`, `perf-course`), interactive dev/QA commands
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

## Exit status, the lock, and phantom failures

The remote status is propagated verbatim and never piped (**M11** — no silent green). Three codes
mean the run produced no verdict at all:

| exit | meaning                                                                               |
| ---- | ------------------------------------------------------------------------------------- |
| `2`  | refused before any network call (macOS-only recipe, unknown recipe, unpushed sha)     |
| `75` | the remote worktree was locked by another run — `BLOCKED`, not `FAIL`                 |
| `76` | the remote checkout **moved mid-run** — `VOID`; the suite output above proves nothing |

**`~/ci/futo-main` is the runner's own working area. Do not `cd` into it and run suites by hand.**
This is not tidiness. Two users of one checkout corrupt _both_ runs, and the corruption is
indistinguishable from a real regression: a concurrent main-health check on that worktree reported
five phantom test failures and two `Cannot find module` suites for files that exist at one sha and
not the other, and very nearly got reported as a broken `main`. A test runner that manufactures
false red is worse than no runner.

Three defences, in order of how much they can actually promise:

1. **An exclusive lock** around checkout-plus-run — `mkdir` on `~/ci/futo-main.lock` as the atomic
   primitive (no `flock` dependency, works over plain ssh), released by a shell trap on
   `EXIT INT TERM HUP`. A blocked run names who holds it, from which machine and worktree, since
   when, and for which recipe. Default is fail fast; `--wait[=SECONDS]` queues behind the holder;
   `--force-lock` breaks a lock you know is stale. Silently proceeding is not an option.
2. **Sha verification before and after the run.** Git mode asserts the checkout landed on the sha it
   asked for, and both modes re-read `HEAD` after the suite finishes and exit `76` if it moved. This
   is the defence that covers what the lock cannot: anyone bypassing `remote-test` entirely. It
   converts silent corruption into a loud, specific error.
3. **Serialisation on top of isolation.** `test:cross-platform` derives its port band from the
   worktree slot (`xplatSyncBand` in `scripts/lib/slot.mjs`) and gives every server its own SQLite
   database in its own temp directory, so two different worktrees on one box no longer collide. That
   does not retire the lock: two runs in the SAME remote worktree hash to the same slot, so they want
   the same ports. What changed is the failure mode — the second run now aborts on the busy port
   naming the holder, instead of adopting the first run's server and its vault mid-scenario (which
   surfaced as a bogus `HTTP 401: session expired`). The lock keeps that from arising at all, and it
   is still cheaper than a per-invocation worktree, which would need its own `node_modules` (a ~40s
   `pnpm install` and real disk per sha).

Bookkeeping (the `pnpm install` stamp) lives in `~/.cache/futo-remote-test/`, never inside the
checkout, so it cannot dirty the tree or confuse a `git status` check.

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

## Reading the timings

Setup dominates the short suites. `pnpm run test:full` on the box is roughly **3 seconds of test
time inside ~25 seconds of environment setup** (ssh, `git fetch`, the vitest/jsdom boot). A run that
looks stalled for twenty seconds is almost certainly setting up, not hung — check the streamed
`==>` lines before concluding anything. The measured end-to-end numbers so far, for calibration:
`test-rust` ~10s, `test-unit` ~30s, `test-cross-platform` 199s for 32/32 scenarios (of which 148s is
scenarios and 51s is the single `large sync` case).

## Known gaps

- `just remote-android`'s instrumentation and storage legs (`test-android-native-ui`,
  `test-android-storage`) need an emulator booted on the box; nothing here boots one yet.
- The box has no display, so a suite that needs one must go in the refused tier, not be "fixed" with
  a virtual framebuffer that then reports different compositing behaviour than either shipped
  engine.
