### Connecting and server trust

- Connecting requires a server URL + password; a successful connect auto-runs a
  first sync. → SyncScreen.kt
- **Opening the app with sync already configured syncs immediately _(desktop)_.**
  The first cycle waits on the boot credential load and nothing else — the
  app-state read plus the keyring password that together make
  `isE2eeConfigured()` answer truthfully — and starts as soon as that settles
  (~0.5 s after process start, measured launch-to-cycle through the instance
  journal). The SSE live stream attaches immediately behind it and runs its own
  catch-up. It is deliberately not deferred by a timer: a flat 8 s deferral
  inherited from the removed Tauri mobile shell put the first cycle 8.6 s after
  launch, which reads as "sync doesn't start when I open the app". A host that
  never runs the credential hook still gets a first cycle from a fallback timer,
  and a first cycle that cannot run yet (no vault configured, offline, user
  already typing) hands off to the existing retry ladder. → autoSync.ts
  `startAutoSync` (guarded by "runs the first cycle as soon as boot
  credentials settle, with no timer wait" in `autoSync.test.ts`)
- Once connected, the server URL is locked. The user can "Sync now" or
  "Disconnect" (desktop labels the disconnect **Reset connection** and asks
  for confirmation; a separate **Forget password** drops only the stored
  keyring entry, keeping the connection). → SyncScreen.kt,
  SyncSettingsSection.svelte
- **The password and server-URL fields suppress IME text "help."** Both declare
  the right soft-keyboard type (password / URI) and disable autocapitalization
  and autocorrect/predictive text. A default text field on a phone silently
  capitalizes the first character or autocorrects, so the bytes sent to the
  server differ from what the user typed — surfacing as a spurious "invalid
  password" or an unreachable host even when the input looks correct. → iOS
  `SecureField` + `.textInputAutocapitalization(.never)`/`.autocorrectionDisabled()`
  on the URL field (SyncView.swift); Android `KeyboardOptions(keyboardType =
Password/Uri, autoCorrectEnabled = false, capitalization = None)`
  (SyncScreen.kt); desktop `type="password"` + `autocapitalize="off"`
  (SettingsScreen.svelte).
- **A server URL without an `http://` or `https://` scheme is rejected before
  any network call**, with the actionable message _"Add http:// or https:// to
  the start of the server URL."_ (surrounding whitespace is trimmed). This turns
  the most common setup mistake into a clear instruction instead of an opaque
  transport error. All three shells pre-validate identically: Android
  `SyncManager.validateServerUrl`, iOS `SyncManager.validateServerURL` (guards
  `connectAndSync`), and desktop `validateSyncServerUrl` (thrown from
  `connectE2ee` before the `e2ee_connect` invoke; surfaced as a catalog
  message). → SyncManager.kt / SyncManager.swift / syncServiceE2ee.ts
- **A plain-`http://` sync server is permitted on every build type, including
  production.** Self-hosters and testers can point at a server without TLS (a
  LAN box, a VPS, or localhost); note content is E2EE-encrypted client-side
  before upload, so cleartext transport carries only opaque blobs + auth. HTTPS
  is still recommended. → Android `AndroidManifest.xml`
  `usesCleartextTraffic="true"` (all build types); iOS `Info.plist`
  `NSAppTransportSecurity → NSAllowsArbitraryLoads` (shared by Debug + Release
  via `project.yml` `settings.base`).
- **An `https://` sync server is verified against the device's own trust store**,
  so a certificate authority the user installed — self-hosted or corporate — is
  trusted, and one the platform distrusts is not.
  → crates/futo-notes-sync/src/tls/mod.rs (`tls::tests`)
- *(all platforms)* The platform's own verifier decides on every handshake,
  through `rustls-platform-verifier`: SecTrust on Apple, CryptoAPI on Windows,
  the system `TrustManager` on Android, the native bundle on Linux. No
  certificates are added to what the OS already trusts, so a device whose
  system store lacks a root fails here exactly as its browser does.
  → crates/futo-notes-sync/src/tls/mod.rs `os_verifier`
- *(Android)* The verifier's Android backend calls into the JVM, which needs a
  one-time binding that UniFFI's JNA loading never performs: the shell loads the
  same library through JNI and hands Rust its application context before any
  sync client exists. The Kotlin half that backend expects is vendored from the
  crate release `Cargo.lock` pins, with two local changes re-applied on every
  bump: it rebuilds its trust manager when the user CA directories change, and
  it checks revocation only from an OCSP response the server stapled, never over
  the network — what Android's own HTTPS stack (Conscrypt) does.
  → FutoNotesApplication.kt · PlatformTrust.kt · crates/futo-notes-ffi
  `platform_trust` · apps/android/app/src/main/java/org/rustls/platformverifier/
- **Installing or removing a CA takes effect on the next sync**, on every
  platform, including connections already open. Before each sync cycle, each
  live-stream reconnect, and each hosted-setup request, every certificate chain
  the session's handshakes accepted is put to the platform verifier again; one
  it no longer trusts drops both of the session's connection pools, so the next
  request makes a fresh handshake and fails with the certificate message, and
  an open live stream reconnects after its own next cycle. The check makes no
  handshake; it costs what the platform's verifier costs (Windows may refresh
  expired cached revocation data over the network, as it does at a handshake).
  It runs before anything else in the cycle, so a cycle that fails early still
  makes it. A live stream runs a cycle at least every safety poll, so it is cut
  within ~45 s of the removal.
  → crates/futo-notes-sync/src/tls/remembering.rs · server/mod.rs `HttpClients`
  (`a_root_removed_while_its_connection_is_pooled_fails_the_next_request`,
  `an_open_stream_reconnects_once_its_root_is_removed`,
  `a_cycle_that_fails_early_still_drops_connections_whose_root_was_removed`)
- *(all platforms)* "Trusted" is the platform's answer at that moment. Apple and
  Windows ask SecTrust / CryptoAPI afresh on every call. Android and Linux keep
  trust in files, so each stat-checks them before every verification, never on a
  timer: Android every entry of the user CA directories
  (`/data/misc/user/<id>/cacerts-added` and `cacerts-removed`, which a Settings
  install, removal, or disable changes — a removal may only empty its file),
  Linux the paths `rustls-native-certs` would load from — `$SSL_CERT_FILE` and
  `$SSL_CERT_DIR` when either is set, the probed system locations otherwise —
  by modification time or size, kept as-is when they are unreadable mid-rewrite.
  The Linux stat-and-rebuild is unit-tested; that `update-ca-certificates` moves
  the probed paths is asserted only by an `#[ignore]`d test that has not yet run
  anywhere.
  → crates/futo-notes-sync/src/tls/reloading.rs (`tls::tests`) ·
  CertificateVerifier.kt `reloadSystemTrustIfChanged`
  (`aUserCaInstalledOrRemovedWhileTheAppRunsDecidesTheVeryNextConnection`, which
  edits the user CA store as root and skips on a device without it)
- *(iOS)* A root installed from a configuration profile also needs full trust
  enabled under Settings → General → About → Certificate Trust Settings.
- **A rejected certificate is reported as such**, not as a generic connection
  failure: the shells surface _"This server's certificate isn't trusted by this
  device. If the server uses a private certificate authority, install it in the
  device settings, then try again."_ Every certificate rejection qualifies, which
  the shells detect by rustls' `invalid peer certificate` prefix rather than by a
  named variant: a missing anchor reports `UnknownIssuer`, while the Apple and
  Windows verifiers wrap a platform trust refusal in `Other(OtherError(..))`
  carrying the OS message, so matching one variant would leave real trust
  failures blaming the URL and password.
  > **Gap:** a verifier that fails *to run* rather than to trust — Windows when
  > `CertGetCertificateChain` itself errors, Apple on its equivalent path —
  > surfaces `rustls::Error::General`, which carries no `invalid peer
  > certificate` prefix and so still reads as "check the server URL and
  > password". Unverified either way: Windows has never been exercised.
  → SyncManager.kt / SyncManager.swift / createSyncSettings.svelte.ts
  `failureMessage`
