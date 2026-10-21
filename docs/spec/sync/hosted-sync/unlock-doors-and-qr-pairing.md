### Unlock doors and QR pairing

- **The unlock screen offers three doors on one screen**: vault password, scan
  from another device, and recovery key. A mistyped recovery key is reported as a
  typo — caught by its check character on the device, with nothing sent — and is
  a different message from a well-formed key that belongs to another vault.
  → `hosted/vault.rs` `unlock_with_recovery_key`, UnlockStep.svelte _(desktop)_,
  UnlockStepView.swift _(iOS)_, UnlockStep.kt _(Android)_
- **The desktop scan door shows a code and waits; it never scans.** _(desktop)_
  A laptop is the new device, so it draws the payload Rust hands it as a QR code
  for an unlocked phone to read (parent spec user stories 13 and 14). Four
  states, each one Rust's answer rendered: **waiting** (the code, a live
  countdown to the relay's own `expires_at`, and Cancel), **received** (the key
  arrived, the vault is unlocked, the first sync is running), **expired**, and
  **refused**. Cancel stops the wait and puts the three doors back, as does
  choosing another door; the code itself stays live on the relay until it ages
  out, so showing one again mints a new one. The countdown only describes the
  deadline — `await_pairing` is rebuilt from that same timestamp and is the only
  thing that ends a wait, so no shell clock can disagree with the engine about
  whether a code is alive. The code is drawn black-on-white in both themes,
  because a camera reads dark modules on a light field. The name on the other
  device's confirmation sheet is this computer's hostname, filled in by the
  desktop shell rather than asked of the frontend.
  → ScanDoor.svelte + `qrCode.ts` + `pairingCountdown.ts` _(desktop)_,
  `e2ee_hosted_begin_pairing`
- **The iOS scan door shows a code too, and a phone can also be the new
  device.** _(iOS)_ The same four states over the same engine calls, drawn with
  CoreImage instead of a JavaScript encoder and counted down by a SwiftUI
  `TimelineView` instead of an interval — the countdown still only describes the
  relay's `expires_at`, and Rust still decides when a code is dead. The code is
  black on white in both appearances and drawn without smoothing, so the modules
  stay square at any size. Cancel and choosing another door both stop the wait
  and put the three doors back. The name the code carries is
  `UIDevice.current.name`, which on a physical device without the
  user-assigned-device-name entitlement is the model name ("iPhone") and on a
  simulator is that simulator's name. Its **received** line says
  the vault is unlocked rather than that notes are syncing, because an iOS
  wizard does not start a cycle yet (the gap under "Reaching a set-up, unlocked
  vault starts syncing"). → ShowPairingCodeView.swift + PairingCodeImage.swift +
  PairingCountdown.swift _(iOS)_
- **An unlocked iOS device can scan another device's code.** _(iOS)_ The account
  card offers "Scan another device", which opens a full-screen camera reading QR
  codes, then one confirmation naming the device that showed the code and its
  platform in words, with Send and Cancel (parent spec user stories 15 and 16).
  Reading a code parses it and nothing else; Send is the only call that seals
  and posts a vault key, and Cancel leaves with nothing sent. The camera reports
  a code only when it changes, so an unreadable one raises its message once
  rather than on every frame. Something that is not a pairing code is named as
  such, and a refused or already-answered pairing puts the camera back with the
  reason on screen instead of ending in a dead end.
  → ScanAnotherDeviceView.swift + PairingScannerView.swift _(iOS)_,
  `hosted/pairing.rs` `complete_pairing` / `confirm_pairing`
- **A device that cannot use its camera says so and names the other door.**
  _(iOS)_ A refused camera permission, a restricted one (parental or MDM
  control), and a device with no camera at all each get their own sentence plus
  the way through anyway: on the device being set up, type the vault password
  (ADR 0003, decision 5). A refused permission also offers Open Settings. The
  camera permission string is a catalog entry rendered into per-language
  `InfoPlist.strings`, and it names both uses of the camera — attaching a photo
  and reading a pairing code. → ScanAnotherDeviceView.swift,
  `permissions.ios.cameraUsageDescription`,
  `scripts/generate-native-language-resources.mjs`
- **The Android scan door shows a code too.** _(Android)_ The same four states
  over the same engine calls, drawn with ZXing instead of CoreImage and counted
  down by a Compose effect instead of a `TimelineView` — the countdown still
  only describes the relay's `expires_at`, and Rust still decides when a code is
  dead. The code is black on white in whatever theme, drawn with no filtering so
  the modules stay square, and carries its four-module quiet zone inside the
  picture rather than relying on layout padding. Cancel and choosing another
  door both stop the wait and put the three doors back. The name the code
  carries is the device name a person set in system settings, falling back to
  the model name when that is unset or unreadable. Its **received** line says
  the vault is unlocked rather than that notes are syncing, because an Android
  wizard does not start a cycle yet (the gap under "Reaching a set-up, unlocked
  vault starts syncing"). → ShowPairingCode.kt + `PairingCodeMatrix.kt` +
  `PairingCountdown.kt` _(Android)_
- **An unlocked Android device can scan another device's code.** _(Android)_ The
  account card offers "Scan another device", which fills the screen with a
  CameraX preview reading QR codes, then one confirmation naming the device that
  showed the code and its platform in words, with Send and Cancel (parent spec
  user stories 15 and 16). Reading a code parses it and nothing else; Send is
  the only call that seals and posts a vault key, and Cancel leaves with nothing
  sent. The camera reports a code only when it changes, so an unreadable one
  raises its message once rather than on every frame. Something that is not a
  pairing code is named as such, and a refused or already-answered pairing puts
  the camera back with the reason on screen instead of ending in a dead end.
  Decoding is **ZXing, not ML Kit**, so the scanner behaves the same on a device
  with no Google Play services — an F-Droid or de-Googled install is not a
  quietly broken one. → ScanAnotherDeviceScreen.kt + PairingScannerView.kt +
  `PairingCodeDecoder.kt` _(Android)_
- **Android asks for the camera at the moment of use, and a refusal is not a
  dead end.** _(Android)_ The `CAMERA` permission is declared in the manifest
  and requested when the scanner screen opens — never during onboarding, never
  on the sync screen. A first refusal gets the reason and an Allow button that
  asks again; a final refusal gets the "camera access is off" sentence and Open
  Settings; a device with no camera at all gets its own sentence. All three also
  name the door that is still open: on the device being set up, type the vault
  password (ADR 0003, decision 5). The two booleans Android answers with are
  read in one place, so "never asked" and "refused for good" — which the system
  reports identically — cannot be confused. → PairingCameraAccess.kt,
  ScanAnotherDeviceScreen.kt, `AndroidManifest.xml`
- **"Expired" is what declining looks like, and the wording says so.**
  _(desktop, iOS, Android)_ The relay carries no declined signal — a person who
  says no on the scanning device sends nothing at all — so a decline and a
  walk-away both reach the waiting device as the five minutes running out. The
  expired screen therefore says a code lasts five minutes and that saying no
  looks the same from here, with nothing shared either way; it never claims to
  know which happened.
  **Refused** is the narrower, rarer case where the relay would not serve the
  pairing at all. → `hosted/pairing.rs` `await_pairing`,
  `sync.hosted.pairing.expired` / `.refused`
- **QR pairing moves the vault key between two devices, new-device-shows.** The
  new device opens a pairing on the server's account-scoped relay and shows a
  code carrying the pairing id, a **one-time X25519 public key**, and its own
  name and platform; the unlocked device scans it, confirms, seals the vault key
  to that public key, and posts the ciphertext; the new device collects it,
  opens it, and keeps the key — after which it is indistinguishable from a
  device set up by password. The private half of the one-time key never leaves
  the new device: it lives only in memory for the life of the code and is never
  returned across the FFI or Tauri boundary.
  → `hosted/pairing.rs` `begin_pairing` / `await_pairing`, `e2ee/sealed_box.rs`,
  `tests/cross-platform-sync.mjs` (`hosted pairing between two desktop
  instances`, which passes the payload between two real app instances as a
  string, the camera being the one part a test cannot have)
- **A wrong scan sends nothing, structurally.** Reading a scanned code parses and
  returns the device name for the confirmation sheet; it touches no network, no
  secret store, and no vault key. Sealing and posting happen only in the confirm
  step, which takes the parsed scan a shell cannot fabricate — on desktop Rust
  holds it and the frontend never sees the pairing id or public key at all, and
  on iOS and Android the shell holds an opaque UniFFI handle with no
  constructor a shell can reach, so the confirmation is a real gate rather than
  a convention. → `hosted/pairing.rs` `complete_pairing` / `confirm_pairing`,
  ScannedPairing.swift _(iOS)_, ScannedPairing.kt _(Android)_
- **A pairing lives five minutes from creation and is collected exactly once.**
  The collecting poll deletes it, so a second poll is not a replay. Waiting past
  the window is `pairingExpired` — which is also what a declined confirmation
  looks like from the waiting device, because declining sends nothing. A relay
  that will not serve the pairing is `pairingRefused`, one answer for unknown,
  expired, already collected, and another account's, because the server answers
  all four identically so a pairing id cannot be probed from another account. A
  second key posted to one's own pairing is `pairingAlreadyKeyed` and is never
  retried: a sealed box is nondeterministic, so a repeat is new bytes the server
  cannot match. → server ADR 0008,
  `tests/hosted_scenarios/mod.rs` (`pairing_hands_the_vault_key_to_a_new_device`,
  `a_scanned_code_sends_nothing_until_the_person_confirms`,
  `collecting_the_key_spends_the_pairing`,
  `a_pairing_this_account_cannot_reach_is_refused`,
  `a_pairing_can_only_be_answered_once`,
  `an_expired_pairing_code_is_its_own_error`,
  `another_accounts_live_pairing_is_refused`)
