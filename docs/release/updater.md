# Desktop in-app updater — release, CI & signing

The desktop app self-updates via the Tauri updater plugin: the client polls an
endpoint, downloads a minisign-signed artifact, verifies it against the pubkey
baked into the build, swaps, and relaunches. The *behavior* (update banner,
Settings → Updates, the "automatically check" toggle) is specced in
`docs/spec/app.md` + `docs/spec/settings.md`; the keys and trust boundary live
in `keys/README.md`. This doc covers the build/release/CI wiring.

## Profile-based release

One runner, `scripts/release-build.mjs --profile <localdev|prod>`, does the
identical build→re-sign→`build-updater-manifest.mjs` chain; only three inputs
differ (host endpoint, signing private key, baked verify pubkey):

- **prod** — `tauri.updater-release.conf.json` (prod endpoint + pubkey from
  base), signed by `TAURI_SIGNING_PRIVATE_KEY` (CI secret). Artifacts + manifest
  written to `--out` for CI to upload.
- **localdev** — `tauri.updater-localdev.conf.json` (localhost endpoint +
  committed throwaway pubkey + insecure transport), signed by
  `keys/localdev-updater.key`. `just updater-localdev` runs the full local E2E
  (build OLD+NEW signed AppImages → serve → run prior app → verify swap).

The localdev↔prod trust boundary (why the localdev key is safe to commit) is in
`keys/README.md`, enforced by `updaterConfig.test.ts`.

## CI release wiring

`.gitlab-ci.yml` + `.cirrus.yml`, tag pipelines. Each desktop build emits a
signed updater artifact + `.sig` (minisign), which `release:` assembles into one
`latest.json`. Per-OS the re-sign is always the LAST touch on the bytes:

- **Linux** — build the AppImage keyless → mesa patch → `cargo tauri signer sign`.
- **Windows** — build the setup.exe keyless on the VM → `windows:sign` does
  Authenticode (jsign) → re-minisign via `npx @tauri-apps/cli signer sign` (so
  the signing key never reaches the Windows VM).
- **macOS** — build with `--config tauri.updater-release.conf.json` so Tauri
  notarizes then produces + minisigns the `.app.tar.gz` in one step (key passed
  to Cirrus via the `.cienv` `TAURI_` passthrough).

`release:` uploads each artifact + a `latest.json` to the package registry and
adds `latest.json` as a release asset with `filepath:/latest.json`, so the baked
`releases/permalink/latest/downloads/latest.json` endpoint resolves.

**Required CI variable:** `TAURI_SIGNING_PRIVATE_KEY` (protected; the prod key
content — the key has no password; `-p ""` / `--ci` supply the empty passphrase
the minisign format requires, so there is no password variable). `release:gate`
blocks the release unless every `.sig` + the macOS `.app.tar.gz` are present.

## Channel = stable only

The `release:` job runs only on stable semver tags (`/^v\d+\.\d+\.\d+$/`);
prerelease tags (`-rc`/`-nightly`) still run the build jobs (for artifact
validation) but publish no release, so `permalink/latest` only ever resolves to
a stable release. The client never downgrades (semver compare), so installs only
move UP to the newest stable.

Edge: a backport stable tag (older patch published after a newer minor) becomes
`permalink/latest` by date — clients above it won't downgrade, but clients below
get the backport, not the highest minor. A future **nightly channel** = a second
fixed manifest URL + a client `updateChannel` setting that selects the endpoint.

## Signature / baked-pubkey guard

`scripts/verify-updater-signature.mjs` is a pure-Node minisign verifier
(Ed25519 + BLAKE2b-512, no `minisign` binary). Both `release-build.mjs` (every
localdev/prod build, in `buildOne`) and CI's `release:` job (before assembling
`latest.json`) verify each artifact's `.sig` against the pubkey its client bakes
— localdev from the overlay, prod from base `tauri.conf.json`.

This catches the single irreversible foot-gun: a signing-key/baked-pubkey
mismatch that would brick auto-update for the entire install base (the pubkey
can't be rotated on shipped installs), plus any stale `.sig` left from before the
OS-signing step rewrote the bytes. A mismatch fails the build/release loudly
instead of shipping a permanently-unupdateable client.

## Re-sign ordering (critical)

The detached `.sig` must be the LAST touch on an artifact — after the Linux mesa
patch and after macOS notarize / Windows Authenticode (jsign). `release-build.mjs`
re-signs after the mesa patch; CI must re-sign after the OS-signing step. (The
`release:` signature-verify step above is a second backstop: a `.sig` made before
a byte-mutating step fails verification.)

## Not yet validated end-to-end

The CI release path is wired + adversarially reviewed but never run through a
real tag pipeline. The signature verification above proves key↔sig↔artifact
correctness before publish, but the actual download→swap→relaunch on a client is
still first proven only by the **second** stable release (an existing install
auto-updating to it). `scripts/release-build.mjs` (`just updater-localdev`) is
the local mirror that IS validated.

## Tested by

`src/lib/updater.test.ts`, `src/lib/updateChecker.svelte.test.ts`,
`src/components/UpdateBanner.svelte.test.ts`, the config conformance guard
`src/lib/platform/updaterConfig.test.ts` (base HTTPS-only/no-insecure/
`createUpdaterArtifacts` off; localdev is the only place localhost/insecure/
localdev-key may appear), the stable-only channel-regex guard
`scripts/release-channel.test.mjs`, the signature verifier
`scripts/verify-updater-signature.test.mjs` (real localdev-signed fixture →
verifies; prod pubkey / tampered bytes / corrupted key → rejected), and
`scripts/{build-updater-manifest,release-build}.test.mjs`. All run in
`test:unit:minimal` (so CI gates them). The real download→verify→swap→relaunch
is a per-release manual smoke per OS (an OS-level op, not unit-testable) —
`just updater-localdev` is the closest automated rehearsal.
