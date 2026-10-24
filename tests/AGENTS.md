# AGENTS.md — tests/

Four different kinds of test share this directory. Knowing which one you are touching decides how
you run it and what a green result actually proves.

| What                   | Where                                     | Runner                                     |
| ---------------------- | ----------------------------------------- | ------------------------------------------ |
| Browser end-to-end     | `*.spec.ts`                               | Playwright, against the Vite dev server    |
| Editor-embed           | `editor-embed-*.spec.ts`                  | Playwright, its own config, `file://`      |
| Cross-language goldens | `conformance/`, `localization/cases.json` | Rust, Vitest, Swift, Kotlin                |
| Real-app harnesses     | `*.mjs` + `lib/`                          | plain Node against a running app or device |

Unit tests live next to the code they test, not here. `lib/*.test.mjs` is the exception — those test
the harness helpers themselves and run under Vitest.

## Playwright specs

`playwright.config.ts` points at this directory and ignores `editor-embed-*.spec.ts` (own
config, no dev server — `globalSetup` builds the single-file `editor.html` and every test loads it
over `file://`) and `*.test.mjs` (Vitest files, whose matcher runtime conflicts with Playwright's).

```bash
just test-e2e          # the P0 regression spec — the smoke run
just test-e2e-rest     # exactly what CI's test:e2e:rest job runs
pnpm run test:e2e:full # every dev-server spec — NOT the editor-embed one
pnpm run test:e2e:editor-embed    # the only way to run the embed spec
pnpm exec playwright test tests/search.spec.ts      # one spec
pnpm exec playwright test -g 'partial test title'   # one test
```

Run `just browser-install` after dependency installation or a Playwright upgrade: it installs
Chromium at the revision required by this worktree's lockfile, including the headless shell.
The recipe disables browser-cache garbage collection so installation cannot prune a revision
another worktree is using; it does not automatically clean the shared browser cache.
`just browser-install webkit` installs WebKit when a test explicitly needs it; browser downloads
do not supply missing Linux system libraries. Use the Linux host's supported package setup or a
prepared test host for those dependencies; a Chromium pass does not prove WebKit behavior.

On a Linux host with rootless Podman, run
`just test-browser-container webkit tests/p0-regressions.spec.ts` instead. This uses the
[official Playwright image](https://playwright.dev/docs/docker) at the exact installed package
version, supplying matching browsers and system libraries without installing host packages.
The first run may download a large image; cached images are retained. `chromium` and `firefox`
are also accepted as the first argument. The optional container config selects that engine and
starts its own no-watch Vite server inside the container; ordinary Chromium/CI selection is
unchanged. Networking is isolated (loopback only), so tests needing an external server need a
separate supported setup. Each invocation prints a fresh `verification-runs/browser-container-*`
directory for reports, traces and screenshots. Only this invocation's container is removed;
the checkout and image caches are retained. This proves Playwright WebKit, not native WebKitGTK.

For a standalone browser diagnostic, start `just web-diagnostic` in this worktree. It uses the
slot-derived web port and disables Vite's file watcher, avoiding another inotify consumer while
shards are running. It serves current source on request but provides no HMR; restart after edits.
Playwright-managed servers already disable watching. In a second terminal **in the same worktree**,
run `just test-e2e-reuse tests/search.spec.ts` to explicitly reuse that server. Check its startup
path/port before reusing it; the ordinary recipes keep rejecting occupied ports so a different
worktree's server cannot silently supply the test app. Stop only the diagnostic process you
started (Ctrl-C in its terminal). These browser diagnostics prove web behavior, not native pixels.

`pnpm run test:e2e:full` is plain `playwright test` under the default config, which `testIgnore`s
`editor-embed-*.spec.ts` — so "run everything" leaves the native editor's bridge contract and the
Milkdown round-trip suites untested unless you also run `pnpm run test:e2e:editor-embed`.
That run always starts with a production Vite build of the editor bundle (its globalSetup,
`tests/editorEmbedBundle.ts`, rebuilds so a stale `editor.html` cannot pass), so it counts as a
build when a task rules builds out. Every run builds into a private
`build/editor-embed-*/` directory and removes only that directory on teardown.
Native builds and simultaneous embed/gauntlet runs cannot erase its bundle.

`just test-unit` is **Vitest**, not Playwright — use it for the co-located unit tests and the
harness helpers under `lib/`, not for a `.spec.ts` here.

Playwright **wipes** `test-results/` at the start of every run, so a failed run's trace and video
are gone the moment you re-run to check whether it was a flake; set `PW_RUN_ID=before` /
`PW_RUN_ID=after` to keep runs side by side. The default config runs single-worker
(`workers: 1`, `fullyParallel: false`); CI's `test:e2e:rest` job overrides that with `--workers=2`.
CI splits `test:e2e:rest` and `test:e2e:editor-embed` into three jobs each by file
(`--shard=N/3`), so a red shard holds only its share of the specs; reproduce one with
`pnpm run test:e2e:rest --shard=2/3`. Put the flag straight after the script name: after a `--`,
pnpm forwards the separator and Playwright quietly runs the whole suite.

A Playwright pass proves nothing about WebView2 or a real iOS keyboard (AGENTS.md M22). Those need
`scripts/win-vm/` and a device.

## Cross-language goldens

`conformance/` is the enforcement mechanism for the one permitted Rust↔TypeScript duplication.
`*.json` are hand-reviewed goldens (is the rule correct?); `title-rules-differential.mjs` is a
generated differential over adversarial inputs (do the two languages agree?). Neither subsumes the
other — `tests/conformance/README.md` explains why, and `packages/editor/AGENTS.md` owns the edit
procedure. `localization/cases.json` is the same idea for language matching and plurals, read by
TypeScript, Swift, and Kotlin alike.

Editing a golden is a deliberate act: it means a human decided the intended behavior changed. Never
adjust one to make a run green.

```bash
just test-rust         # Rust goldens + the full differential
```

## Real-app harnesses

These drive actual apps, so they can leave state behind and they can touch devices.

- `cross-platform-sync.mjs` (`just test-cross-platform`) boots two Tauri test clients and the pinned
  sync server, and pairs a desktop client with the real native Android app when a device is
  reachable. No device means a loud SKIP and the desktop-only mesh — read the output, don't assume.
  The file is the entry point; scenarios live in `cross-platform-sync/*-scenarios.mjs` and are
  registered in `cross-platform-sync/scenario-registry.mjs`.
- `ios-editor-stories.mjs` (`just test-ios-stories`) types at human cadence into the real iOS app and
  uses the simulator vault as the oracle. Needs a claimed `SIM`.
- `android-storage-migration.mjs` (`just test-android-storage`) **clears the debug app's data**.
  Claim a pool device with `just qa-claim android` first; never point it at a phone you care about.
- `desktop-smoke.mjs` (`just test-desktop-smoke`).

`lib/vaultInvariant.mjs` is the shared oracle: after a story, the vault must contain exactly what the
story asked for and no unrequested conflict copies. Assert with it rather than eyeballing a
screenshot.

## Rules

Writing a test here means living under M11 (a job that misses its purpose fails red), M15 (wait on
conditions, not sleeps), M21 (suspect the tool before the app), and M24/M25 (drive only a target
`just qa-target` verified, terminate only by identity). The root manual carries all four and is
loaded every session — read them there rather than trusting a paraphrase here.

Two things this layer adds:

- **A bug fix gets a regression test that fails before the fix.** Not a test written after the fix
  that happens to pass.
- **Portable suites belong on the Linux box**, not on the Mac, which is needed for the work only it
  can do: `node scripts/remote-test.mjs test-unit`, `node scripts/remote-test.mjs check`,
  `just remote-sync`.
  `scripts/remote-test.mjs` refuses macOS-only recipes by name and propagates the remote exit
  status verbatim. What a Linux run cannot prove — the WebKitGTK/WKWebView boundary — is in
  `docs/remote-testing.md`.
