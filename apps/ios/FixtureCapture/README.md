# Isolated #294 capture fixture

Preparation only. `just build-ios-capture-fixture` rebuilds Rust in `release-ffi`,
records exact source/dirty-file fingerprints and generated-library/binding hashes,
then compiles an unsigned standalone app and its native unit-test bundle for a
generic simulator plus the app for a generic iOS device. It never selects,
claims, installs, launches, provisions, or drives any device. `just
test-ios-capture-artifact` runs the Foundation artifact contracts on the host.
`SIM=<claimed-UUID> just test-ios-capture-fixture` runs the native unit bundle only
on an already owned, booted pool simulator after the build; it never auto-claims
or accepts a physical destination. The native tests are synthetic calls and public store projection checks; neither
suite is actual OS dictation evidence.

The only application identity is `org.futo.fixture.editor294`; the test bundle is
`org.futo.fixture.editor294.tests`. `FixtureApp` compiles no shipping app startup,
default-vault resolver, sync, license, keychain, or catalog UI. Its sole visible
content is fixed note data, projected by the generated public `NoteStore` /
`NativeEditorSession` facade into the ordinary observing UITextView shared with
the DEBUG recorder overlay. Input is observed and forwarded unchanged to UIKit;
control contents are never written back to the source note.
The standalone host uses UIKit's scene lifecycle. The observing control reports
the same optional dictation capabilities as the base `UITextView`; it forwards
implemented callbacks once and only records synthetic calls to absent callbacks.

A future sanctioned Puppet capture must provide `FUTO_EDITOR_CAPTURE_LAUNCH` as
JSON containing `runID` and `nonce` UUID strings, a nonempty `destination` identifier,
and `seconds` (1–120). The destination is *declared correlation metadata*, not a
verified hardware identity. The app creates exactly one new
`temporaryDirectory/editor294-<runID>/`, refusing an existing path; `vault/` and
atomic `capture.json` are its only outputs. No vault or output path is accepted
from the caller. Artifacts retain the nonce, source/build provenance, raw UTF‑16,
callback IDs/parents, UIKit-returned opaque token identities, traits, lifecycle
and timing. Capture stops at the uptime deadline while active; suspension can
pause the timer, and the subsequent lifecycle/uptime record must be considered
when reviewing a run. Files are retained; no fixture cleanup deletes an ancestor
or another run's directory. The OS can purge temporary files, so later Puppet
must retrieve evidence before ending the owned run.

Every artifact says `unreviewed-raw-capture` and `declared-only`. It cannot claim
physical dictation success. A future reviewed Puppet mode/reservation must bind
compiled identity, exact device/test destination, live lease, real system-keyboard
action receipt and matching nonce before raw evidence can be accepted. That
capability is deliberately absent from this preparation change. Do not invoke an
off-book UI test or substitute direct callbacks for system input. Existing pool,
SIMULATOR_UDID, selector, and allowlist rules remain unchanged.
