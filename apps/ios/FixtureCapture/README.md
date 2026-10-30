# Isolated #294 capture fixture

Preparation only. `just build-ios-capture-fixture` rebuilds Rust in `release-ffi`,
records exact source/dirty-file fingerprints and generated-library/binding hashes,
then compiles an unsigned standalone app and its native unit/UI-test bundles for
generic simulator and iOS device destinations. It never selects,
claims, installs, launches, provisions, or drives any device. `just
test-ios-capture-artifact` runs the Foundation artifact contracts on the host.
`SIM=<claimed-UUID> just test-ios-capture-fixture` runs the native unit bundle only
on an already owned, booted pool simulator after the build; it never auto-claims
or accepts a physical destination. The native tests are synthetic calls and public store projection checks; neither
suite is actual OS dictation evidence.

`just build-ios-capture-fixture-signed <approved-private-selection.json>` is a
separate, explicitly authorized development-signing preparation route. It requires
an exact clean source SHA/fingerprint, fresh uppercase run UUID, previously recorded
phone UDID, certificate SHA1, actual team ID and exact existing wildcard development
profile UUID/path/SHA256. Its strict selection fields are `formatVersion` (1),
`sourceSHA`, `sourceFingerprint`, `runID`, `deviceUDID`, `identitySHA1`, `teamID`,
`profileUUID`, `profileSHA256`, and `profilePath`. The metadata must match the
certificate, development entitlements, expiration and declared phone inclusion.
It performs no device query. No profile search, creation, download, installation,
automatic provisioning or repair is supported.

This route rebuilds `release-ffi` with Cargo offline, disables automatic Xcode
package resolution/updates, generates an isolated project from `project.yml`,
and compiles generic iOS products in a fresh private `.build-signed/<runID>/`.
It signs only the four fixed standalone bundles, inside out, without a timestamp
service, using minimal development app/team entitlements. Both XCTest library
bundles explicitly retain entitlements under the macOS 15 codesign default. The
complete frozen source identity, including checkout cleanliness outside the selected
build inputs, is rechecked after native build and before the success receipt. Bundled provenance says
`signed:false` and `development-signing-requested-not-verified`: it records the
request before signing. Only the separate `verified-signing-receipt.json` records
successful strict signature, leaf-certificate, entitlement, embedded-profile and
final source/artifact verification. A failed or interrupted run retains its
output and never receives a success receipt. Existing outputs are never replaced.

Physical capture consumes only `.build-signed/<runID>/`, selected by the existing
manifest run UUID. It independently rechecks the exact private signing receipt,
selection, clean current source/FFI, all four actual signatures, leaf certificates,
minimal entitlements, embedded profile and product hashes. Receipt and product
file identities are rechecked before pinning and each installation or XCTest use;
identical bytes at a replaced inode also refuse. There is no `.build-native`
fallback or caller-selected product path. The retained build evidence distinguishes
verified external signing state from the bundled pre-signing request metadata.
A successful signed build grants no physical lease, installation, launch,
Dictation, microphone, privacy, unlock or audio permission.

The application identity is `org.futo.fixture.editor294`; the unit bundle is
`org.futo.fixture.editor294.tests`. The UI bundle is `org.futo.fixture.editor294.uitests`,
with runner `org.futo.fixture.editor294.uitests.xctrunner`. `FixtureApp` compiles no shipping app startup,
default-vault resolver, sync, license, keychain, or catalog UI. Its sole visible
content is fixed note data, projected by the generated public `NoteStore` /
`NativeEditorSession` facade into the ordinary observing UITextView shared with
the DEBUG recorder overlay. Input is observed and forwarded unchanged to UIKit;
control contents are never written back to the source note.
The standalone host uses UIKit's scene lifecycle. The observing control reports
the same optional dictation capabilities as the base `UITextView`; it forwards
implemented callbacks once and only records synthetic calls to absent callbacks.

The bounded Puppet capture provides `FUTO_EDITOR_CAPTURE_LAUNCH` as
JSON containing `runID` and `nonce` UUID strings, a nonempty `destination` identifier,
and `seconds` (1–120). The destination is _declared correlation metadata_, not a
verified hardware identity. The app creates exactly one new
`temporaryDirectory/editor294-<runID>/`, refusing an existing path; `vault/` and
atomic `capture.json` are its only outputs. No vault or output path is accepted
from the caller. Artifacts retain the nonce, source/build provenance, raw UTF‑16,
callback IDs/parents, UIKit-returned opaque token identities, traits, lifecycle
and timing. Capture stops at the uptime deadline while active; suspension can
pause the timer, and the subsequent lifecycle/uptime record must be considered
when reviewing a run. Files are retained; no fixture cleanup deletes an ancestor
or another run's directory. The OS can purge temporary files, so later Puppet
must retrieve evidence before ending the owned run. The artifact emits a container-relative
path only after comparing its actual temporary location with its own app-container `tmp/`.

Every artifact says `unreviewed-raw-capture` and `declared-only`. It cannot claim
physical dictation success. Review of the mode and separate human authorization for the
exact phone, unlock, microphone and phrase/audio route are required before physical use.
No physical result is established by compilation, mocked executors, or synthetic unit calls.

## Bounded physical Puppet route

`just puppet physical-fixture capture --manifest <path>`, `read --run <UUID>` and
`close --run <UUID>` form a separate opt-in transport. It never falls through to pooled
resolution. `just physical-fixture-lease acquire <template-path>` starts a fixed foreground
reservation keeper; it performs no device operation. The input template has
exactly these fields:

```text
formatVersion: 1
host: exact transport owner's hostname
deviceUDID: exact physical iPhone hardware UDID (8 hex digits, hyphen, 16 hex digits)
coreDeviceID: independently resolved CoreDevice UUID
worktree: canonical checkout path
sourceSHA: full Git SHA
sourceFingerprint: current source-provenance SHA256
runID, nonce: fresh distinct uppercase UUIDs
bundleID: org.futo.fixture.editor294
runnerBundleID: org.futo.fixture.editor294.uitests.xctrunner
seconds: integer 1–120
buildFingerprint: SHA256 binding the verified signing receipt, selection and original file/directory identities
```

After separately authorized local signature-availability verification,
`just ios-capture-fixture-build-identity <runID>` supplies the canonical checkout/source/build
fingerprints. It reads existing compiled signatures without accessing a device, signing,
or provisioning. It cannot turn the unsigned preparation build into an installable build.

The keeper rejects an input `ownerPID`, inserts its own actual PID, and exclusively writes
an authoritative capture manifest. Its first JSON resource receipt reports that manifest,
PID/start identity, hardware/run identity, explicitly created paths and exact close command.
Keep this foreground process running in its task-owned shell/session. From another task-owned
shell, run capture with the **reported authoritative manifest**, then read and close with its
run UUID. Capture's short-lived process exiting does not release or stale the keeper's lease.
Exact close removes the lease, the keeper observes release and exits; wait/reap that original
process/session handle. No unrelated persistent PID or process-name lookup is involved.
Before a capture output exists, `just physical-fixture-lease release <reported-manifest>`
releases the same reservation and lets the keeper exit. `read` takes the reported manifest too.

The lease records the OS process start/command identity and all these bounds. A live sibling,
stale/recycled owner, changed host/source/build, or existing lease refuses; there is no
automatic takeover. Capture holds an exclusive use file throughout its bounded operation,
so release and another capture cannot race the test. A killed process leaves evidence and
an explicit refusal requiring diagnosis; it never triggers automatic cleanup or takeover.
Stale-owner recovery has no automatic command: retain the resource receipt, verify that exact
owned process has exited and that no capture remains active, then request explicit recovery
of that exact lease. Never remove a sibling/unknown lease, in-use file or computed ancestor.
Read validation also holds the exclusive reservation through artifact validation.

Capture requires a separately authorized, already signed build of these exact products.
The compile-only recipe still disables signing and provisioning; those products alone
cannot pass physical preflight. Capture verifies existing compiled signatures without
signing or provisioning anything, then rechecks the actual hardware/CoreDevice identity,
wired connection, unlocked state, source/build, lease and exact installed fixture identities
before each lifecycle/read operation. Unknown device-result schemas fail closed. No port or
forwarder is opened. Existing fixture/runner installations also refuse; this initial route
does not overwrite or uninstall a prior installation, even one retained by an earlier run.

Only `DictationCaptureTests/testCapture` may execute. It launches this fixture, waits for
the run/nonce-bound field, taps it, locates exactly one live English system Dictate control,
and taps that control. It never enters text, invokes callbacks, dismisses a prompt, changes
settings, or repairs an OS service. Missing/ambiguous Dictate, a prompt, background/locked
state or timeout fails. The raw XCTest bundle and [retained gesture attachment](https://developer.apple.com/documentation/xctest/adding-attachments-to-tests-activities-and-issues)
bind the actual destination separately from the fixture's declaration. Other keyboard
languages and unknown XCTest output schemas refuse rather than being inferred.

Host evidence is retained under the host temporary directory's `futo-editor294/<runID>/`.
Only `tmp/editor294-<runID>/capture.json` is copied from this fixture's exact app-data domain.
No personal app domain is queried. Capture rejects zero/skipped/wrong tests, missing gesture
receipts, wrong source/build/nonce/path, partial JSON, an unfinished marked range, or no text
result. A failed test never causes an automatic read or retry; explicit `read` can preserve
its raw artifact in a fresh owned subdirectory while still returning a failure receipt.
`close` releases the exact completed/failed reservation and retains evidence and installations.
It refuses an unfinished capture. No cleanup removes a vault, installation or evidence tree.

The version-1 recorder wire schema is checked before capture success, successful read,
and release of a captured receipt (`scripts/qa/physical-fixture-artifact.mjs`). It requires
the writer's complete callback snapshots, method-specific arguments/returns, nullable
selections/marked ranges/language/token observations, traits and lifecycle stamps. Unknown
methods, missing members and wrong primitive types fail with the original raw bytes retained
under a failed capture receipt; explicit failed close remains available. This is shape
validation, not callback-order, range-bound, keyboard, Markdown or OS-result interpretation.
The hosted synthetic projection test exports current recorder/writer bytes as
`Editor294SyntheticRecorderArtifact:` for a separately labelled host compatibility replay.

The fixed UI scenario remains physical-only; the simulator test recipe runs only the hosted
synthetic unit bundle. Physical execution and live CoreDevice/XCTest schema validation are
separate outstanding checks. Existing pool, SIMULATOR_UDID, selector, and allowlist rules
remain unchanged. No direct UI-test invocation substitutes for the Puppet route.
