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
  sync client exists. The Kotlin half that backend expects is vendored verbatim
  from the crate release `Cargo.lock` pins.
  → FutoNotesApplication.kt · PlatformTrust.kt · crates/futo-notes-ffi
  `platform_trust` · apps/android/app/src/main/java/org/rustls/platformverifier/
- **Installing or removing a CA takes effect on the next sync**, with no
  reconnect. An already-open connection keeps its handshake until it closes.
  Apple and Windows are asked afresh at every handshake; Linux has no trust
  service, only files, so its verifier is rebuilt when the paths
  `rustls-native-certs` would load from — `$SSL_CERT_FILE` and `$SSL_CERT_DIR`
  when either is set, the probed system locations otherwise — change modification
  time or size, stat-checked before each verification callback and never on a
  timer, and kept as-is when they are unreadable mid-rewrite. The stat-and-rebuild
  mechanism is unit-tested; that `update-ca-certificates` moves the probed paths
  is asserted only by an `#[ignore]`d test that has not yet run anywhere.
  → crates/futo-notes-sync/src/tls/reloading.rs (`tls::tests`)
  > **Gap:** *(Android)* a CA installed or removed while the app runs goes
  > unnoticed until the app restarts, and a revoked CA keeps working for the life
  > of the process; neither a reconnect nor a new sync client refreshes it. The
  > verifier's Kotlin half hands `TrustManagerFactory.init()` a non-null
  > `AndroidCAStore` behind a private `Lazy`, so the anchors are resolved once per
  > process. (Its `systemTrustAnchorCache` is *not* the cause — that one only
  > classifies a root as system-vs-user for revocation policy.) Closing this needs
  > a public invalidation hook in `rustls-platform-verifier`; patching the
  > vendored copy would fork a file that must stay verbatim to be re-vendored on
  > every crate bump. Measured on an emulator, tracked as futo-notes#171.
  > → apps/android/app/src/main/java/org/rustls/platformverifier/CertificateVerifier.kt
  > **Gap:** *(Android)* the same vendored file's `isKnownRoot` never advances
  > its index on its two `continue` branches. It runs for every handshake without
  > a stapled OCSP response, and spins only when the chain's root shares a subject
  > hash with a system anchor whose file still exists but whose keystore entry is
  > gone — disabled by the user, or dropped by a Conscrypt update — or is not an
  > X509 certificate. A private CA exits on the first iteration. When it does
  > spin, the verifying thread is lost for good; the client sees the 10s connect
  > timeout (5s on the initial `auth_mode` probe), so it reads as slow sync, and
  > each retry burns another worker. Same fix path, same tracker.
  > → apps/android/app/src/main/java/org/rustls/platformverifier/CertificateVerifier.kt
  > → crates/futo-notes-sync/src/server/mod.rs `CONNECT_TIMEOUT` `PROBE_TIMEOUT`
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
