# Log in with FUTO, on Android

## Why a person, not a test

Four things in this flow only exist on a device:

- the **Chrome Custom Tab** that sign-in, checkout and the customer portal open in,
  and the way the app picks the person's return up from its own pause/resume pair;
- the **Android Keystore** entry that holds the vault key and the session token, and
  therefore whether a cold start really lands on the account card;
- the **camera**, for the scanning half of pairing;
- the **rendered QR code**, for the showing half.

Everything downstream of those is already automated — the engine's steps in
`crates/futo-notes-sync/tests/hosted_scenarios/`, the Kotlin wizard model against a
stand-in in `just test-android-native`, and the whole flow on desktop in
`tests/cross-platform-sync.mjs`.

## Setup

**The FFI profile is the step that used to be easy to get wrong.** `hosted_server()`
honours `FUTO_HOSTED_SERVER` only in a build with `debug_assertions` on, and the default
`release-ffi` profile inherits `release`, where it is off. `just android-native` now
honours `FUTO_HOSTED_SERVER` itself: when it is set, `apps/android/run.sh` switches to
the `dev` profile and launches the app already pointed at that address, so neither needs
doing by hand any more. A build with `FUTO_HOSTED_SERVER` unset (or a release APK, which
ignores it regardless) silently probes `https://notes-sync.futo.org`, which on a machine
with no route to it reads as "Couldn't reach the server. Check your connection." — a
message about the wrong server entirely.

```sh
just qa-claim android                 # prints ANDROID_SERIAL; claim before anything
export ANDROID_SERIAL=<from above>

# A server whose identity provider and billing are in-process fakes. The pinned
# release predates that mode, so today it comes from a local checkout.
FUTO_NOTES_E2EE_SERVER_REPO=<futo-notes-server checkout on hosted-server> \
FUTO_NOTES_E2EE_SERVER_STANDIN=1 just qa-server --standin
```

The stand-in server binds loopback **and** starts two more loopback listeners on
ephemeral ports — the stand-in identity provider and the stand-in payment provider. The
Custom Tab is redirected to both, so all three need forwarding, not just the server's,
and the app must be launched on `127.0.0.1`, not `10.0.2.2`: the redirect chain sends
the tab to the other two on `127.0.0.1`, and mixing the two host names leaves the tab
unable to reach them.

```sh
# The server's port, then every other port that process is listening on.
adb reverse tcp:<sync port> tcp:<sync port>
ss -ltnp | grep "pid=$(cat ~/.futo-notes-qa/server/s<slot>/server.pid)"
adb reverse tcp:<issuer port> tcp:<issuer port>
adb reverse tcp:<billing port> tcp:<billing port>

FUTO_HOSTED_SERVER=http://127.0.0.1:<sync port> just android-native
```

Confirm the override landed before touching the UI — `just android-drive logs` should
carry `hosted sync pointed at http://127.0.0.1:<port> (debug override)`. Without that
line the run is against the real service and proves nothing. To relaunch pointed at a
different address without a full rebuild, `adb shell am start -n
com.futo.notes.dev/com.futo.notes.MainActivity --es futo_hosted_server <url>` still works
directly — that's the mechanism `run.sh` is now driving for you.

Two mechanics, from driving this:

- `adb shell input text` mangles **spaces** (`%s`) often enough that a vault password
  with spaces in it fails the repeat-field comparison while both fields look identical
  on screen. Use a password with no spaces. This is the tool, not the app.
- `just android-drive tap <label>` misses some Compose controls on this screen — the
  recovery-key checkbox in particular. Read the coordinates out of
  `just android-drive tree` and `adb shell input tap` them.

Release the device afterwards: `just qa-release`, and `just qa-server-stop --drop`.

## The story

### 1. A brand-new account reaches an account card

1. Settings → **Sync**. Expect "Sync with FUTO", a **Log in with FUTO** button, and a
   line naming the address it will sign in at — the stand-in server's, not FUTO's.
2. Tap **Log in with FUTO**. A Custom Tab opens and finishes on the server's own
   completion page. Press **Back** to return to the app.
3. The wizard should already have moved on by itself, to **Subscribe to FUTO sync**.
   Tap **Subscribe**, let the tab open, press **Back**.
4. **Choose a vault password**: type one twice. Expect a strength reading and the
   sentence saying this password is separate from the FUTO password.
5. **Create vault**. Expect the recovery key **once**, seven groups of four, with Copy,
   Share, the plain statement that FUTO cannot recover the vault without it, and a
   checkbox that Continue is disabled until you tick.
6. Tick it, **Continue**. Expect the account card: the email, the subscription in
   words, storage used, Change vault password, New recovery key, Scan another device,
   Manage subscription, Sign out.

### 2. Sign out keeps the notes, and the vault password gets back in

7. **Sign out**, confirm. Expect the sign-in screen back, and the note count unchanged
   (`just android-drive state`).
8. **Log in with FUTO** again. Expect **Unlock your vault** with three doors, not the
   subscribe step: this account has a vault now.
9. Vault password → **Unlock**. Expect the account card.

### 3. Showing a pairing code

10. From the unlock screen, choose **Scan from another device** → **Show a pairing
    code**. Expect a QR, a countdown to the relay's own deadline, and Cancel.
11. The code is real and account-scoped: the server's `device_pairings` row should name
    this device and carry a public key, an expiry, and no ciphertext yet.
12. **Cancel** returns the three doors.

### 4. Scanning a pairing code

13. From the account card, **Scan another device**. Expect the camera permission ask on
    the first run, then a live preview and the "point the camera at the code" line.
14. With a code actually in front of the camera, expect the confirmation sheet naming
    the other device before anything is sent, Cancel sending nothing, and Send reaching
    "Key sent" while the other device moves on.

### 5. Changing the vault password

15. Account card → **Change vault password**. Expect to be asked only for the new one,
    twice, and told why.
16. Set it, sign out, sign in. Expect the **old** password refused by name and the new
    one to unlock.

## Previous run — 2026-09-16 (`3adf4a54`)

Branch docs/vault-unlock-client at `3adf4a54`, debug build with
`FUTO_ANDROID_FFI_PROFILE=dev`, emulator `futo-qa-2` (`sdk_gphone64_x86_64`, API 36),
against a real stand-in server on `127.0.0.1:3108` over `adb reverse` (plus its issuer
and billing ports), stopped by PID afterwards.

**1 — brand-new account: PASS.** Real Custom Tab both times; the login tab landed on
"Signed in to FUTO Notes / You're signed in / Go back to FUTO Notes to finish setting up
this device", and pressing Back found the app already on **Subscribe to FUTO sync** —
the app had picked the session up on its own. Checkout the same. The password screen
read "Strong" for a 16-character password. The recovery key came up once as
`03PT-PZPX-CH68-2GTC-BZCZ-EQNR-K40N`, with Copy, Share, "FUTO cannot recover your vault
without it. Nobody at FUTO has a copy." in red, "You will not be shown this key again.",
and Continue greyed until the checkbox was ticked. The account card read
`person@standin.test` · `Active` · `0 B of 10 GB used`.

**2 — sign out: PASS.** The confirmation says the notes stay on the device; after
confirming, the note count was still 1 and the screen was back to "Log in with FUTO".
Signing in again went straight to **Unlock your vault** with the three doors — no
subscribe step — and the vault password unlocked it.

**3 — showing a code: PASS.** A QR rendered with "This code expires in 4:55." and
Cancel. The server's `device_pairings` row carried
`device_name=sdk_gphone64_x86_64 platform=android`, a public key, an expiry five minutes
out, and no ciphertext. Cancel put the three doors back.

**4 — scanning: PARTIAL.** The scanner screen opened with `android.permission.CAMERA`
granted and a live CameraX preview. **Not run this time**: a code actually in front of
the camera, the confirmation sheet, and Send. futo-notes#183 did run that end, with the
emulator's `-camera-back virtualscene` showing a pairing QR as a scene poster, and it is
the only way to get a real frame into an emulator.

**5 — changing the vault password: PASS.** The screen asks only for the new password,
twice, and says why. After setting it and signing out and in, the old password was
refused with "That is not this vault's password." and the new one unlocked the vault.

### Not proven by this run

- **A physical phone's camera.** Every emulator run stands in for it; futo-notes#183's
  virtual-scene run is the closest anything has come.
- **The no-camera-hardware screen.** Every emulator has a camera, so the sentence for a
  device without one rests on its unit test.
- **The QR's contents.** futo-notes#183 decoded the code out of a screenshot with ZXing
  and matched it against the relay row byte for byte; this run checked the relay row
  only, because no decoder was to hand.
- **The Custom Tab dismissal race.** The app moved on by itself both times here. The gap
  in `docs/spec/sync.md` is about the case where it cannot, after the app has been out
  of sight long enough for the platform to refuse a background activity start.

## Last run — 2026-09-16 (`hosted/c1` at `e6f7d313`)

The C1 run, which is about the one thing the previous run could not do: whether
finishing the wizard starts a sync, and whether a relaunch resumes it. Debug build
installed with `FUTO_ANDROID_FFI_PROFILE=dev bash scripts/build-rust-android.sh` plus
`./gradlew :app:installDebug` (`apps/android/run.sh` still builds the FFI with the
default profile, which compiles the address override out — ticket C5), emulator
`futo-qa-0` (`sdk_gphone64_arm64`, API 36), against the same stand-in server on
`127.0.0.1:3107`. The second instance was the desktop Tauri dev app on that server.

**Both of the stand-in's listeners have to be reversed**, and pointing the app at
`127.0.0.1` rather than `10.0.2.2` is what makes the Custom Tab work: the server builds
its hand-off URL from its own address, so a tab handed `http://127.0.0.1:3107/...`
inside the emulator needs `adb reverse tcp:3107 tcp:3107` — and the fake issuer it
redirects to needs `adb reverse tcp:<issuer port> tcp:<issuer port>` as well, or the tab
dies on `ERR_CONNECTION_REFUSED` at `/authorize`. With `--es futo_hosted_server
http://10.0.2.2:3107` the sign-in screen names the right address and the POST works, and
then the tab cannot reach the URL it is given.

**The wizard's end starts a sync: PASS.** After `pm clear` (a genuinely first-run
device), the storage picker, then **Settings → Sync → Log in with FUTO**: a real Custom
Tab opened, the stand-in signed in, the tab closed itself and the wizard was already on
**Unlock your vault** with nothing else tapped. The vault password landed on the account
card reading `person@standin.test` · `Active` · **`1.4 KB of 10 GB used`** ·
**`Sync complete`** — the figure the previous run could only see as `0 B of 10 GB used` —
and all seven notes of the account were in
`/storage/emulated/0/Android/data/com.futo.notes.dev/files/futo-notes`.

**A note reaches this device with nothing tapped: PASS.** A note written on the desktop
instance and pushed appeared on the emulator as `c1-android-live-note.md` within twelve
seconds, over the live stream, with the Sync screen simply left open.

**A restart resumes, with Settings never opened: PASS.** `am force-stop`, then a note
written on the desktop instance while the app was down, then `am start` of
`MainActivity`. Without opening Settings, `c1-android-restart-proof.md` was on disk and
at the top of the note list within twenty seconds.

### Not proven by this run

- **Pairing and sign out** were not re-walked; the previous run above covers them.
- **A physical phone's camera**, as ever.
- **A device that has a self-hosted password stored — on Android.** `restoreSession`
  still prefers the password branch, but a device is no longer left holding both
  credentials: starting a hosted session clears the stored password
  (`VaultSecrets::delete_sync_password`, reached from `KeystoreVaultSecretStore`), so
  the branch that runs first is the one that matches this device's mode. The rule is
  covered by the engine's own scenario
  (`finishing_hosted_setup_clears_the_self_hosted_password`, run against both the stub
  and a real stand-in server) and was driven end to end **on the iOS simulator**
  (`docs/qa/hosted-sync-ios.md`, 2026-09-16); this emulator was cleared first, so no
  Android run has walked it. The Android leg of that fix is compile-verified plus
  `just test-android-native` only.
- **Switching to hosted while a self-hosted session is live — on Android.** The iOS run
  found that `connectHosted` returns early when a password session is already
  connected, so the wizard finishes without starting a hosted session or clearing the
  password. `SyncManager.kt` `connectHostedLocked` carries the same guard, so Android is
  expected to behave identically, but that was not driven here. Recorded as a gap in
  `docs/spec/sync.md`.
- **Offline at boot.** Covered only by the JVM tests; no run has pulled the network out
  from under a launching app.
