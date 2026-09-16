# Log in with FUTO, on iOS

## Why a person, not a test

Four things in this flow only exist on a device:

- the **`ASWebAuthenticationSession`** sheet that sign-in, checkout and the customer
  portal open in, including the system consent alert in front of it;
- the **Keychain** entry that holds the vault key and the session token, and therefore
  whether a cold start really lands on the account card;
- the **camera**, for the scanning half of pairing;
- the **rendered QR code**, for the showing half.

Everything downstream of those is already automated — the engine's steps in
`crates/futo-notes-sync/tests/hosted_scenarios/`, the Swift wizard model against a
stand-in in `just test-ios-native`, and the whole flow on desktop in
`tests/cross-platform-sync.mjs`.

## Setup

The simulator shares the Mac's network stack, so a server on the Mac's loopback needs
no forwarding — unlike Android, where all three of the stand-in server's listeners have
to be reversed.

```sh
just qa-claim ios                     # prints SIM; claim before anything
export SIM=<from above>

# A server whose identity provider and billing are in-process fakes. The pinned
# release predates that mode, so today it comes from a local checkout.
FUTO_NOTES_E2EE_SERVER_REPO=<futo-notes-server checkout on hosted-server> \
FUTO_NOTES_E2EE_SERVER_STANDIN=1 just qa-server --standin

just ios-native                       # sets FUTO_IOS_FFI_PROFILE=dev for you
```

`apps/ios/run.sh` already builds the FFI with the `dev` profile, which is what the
hosted-address override needs — `hosted_server()` honours `FUTO_HOSTED_SERVER` only
where `debug_assertions` is on, and the default `release-ffi` profile inherits `release`,
where it is off. (Android has no such default; see that story.)

Relaunch pointed at the stand-in server. `simctl` passes environment through with a
`SIMCTL_CHILD_` prefix:

```sh
xcrun simctl terminate "$SIM" com.futo.notes.dev
SIMCTL_CHILD_FUTO_HOSTED_SERVER=http://127.0.0.1:<sync port> \
  xcrun simctl launch "$SIM" com.futo.notes.dev
```

The sign-in screen names the address it will sign in at. If it does not say the
loopback one, the override did not land and the run proves nothing.

Two mechanics, from driving this:

- **A 0x0 root from `axe describe-ui` is not an app failure.** It means the simulator
  has no window in this WindowServer session — which, on a Mac with no Simulator.app
  (Xcode 27 ships none), is the normal state after a plain boot. `just qa-claim ios
  --reboot` fixes it; `simctl` screenshots keep working the whole time, which is why it
  looks like an app bug.
- **A leftover self-hosted password used to hide the hosted restore — fixed 2026-09-16.**
  `restoreSession` still takes the password branch first, and `Keychain.syncPassword` is
  app-global rather than per-vault; what changed is that a device can no longer hold both
  credentials. Starting a hosted session clears the stored password in the engine
  (`VaultSecrets::delete_sync_password`, called from `HostedSetup::connect_sync`), so the
  branch that runs first is the one that matches this device's mode. Proven on this
  simulator below. `xcrun simctl uninstall` plus `xcrun simctl keychain "$SIM" reset` is
  still the right way to get a genuinely first-run device, and it is still the fix for a
  device stranded by a build from *before* that change — such a device never reaches a
  hosted connect, so nothing clears its password until the sync screen is opened once.
- **`SIMCTL_CHILD_FUTO_HOSTED_SERVER` is a property of the launch, not of the install.**
  A plain `xcrun simctl launch` for a restart test drops it and the app silently goes
  back to the baked production address, which surfaces as "Couldn't reach the server" on
  the hosted screen and looks like a hosted-sync bug. Set it on **every** launch in a
  restart story, not just the first.
- **`axe tap -x -y` on a SwiftUI `Toggle` reports success and does nothing** — the
  recovery-key checkbox in particular. `axe tap --id <accessibilityIdentifier>` uses the
  element's own activation point with a physical touch and does flip it. This is
  AGENTS.md M21 exactly: suspect the tool before the app.

Clean up: stop the server, `just qa-release`, and remove any worktree you added.

## The story

### 1. A brand-new account reaches an account card

1. **Sync** in the toolbar. Expect "Sync with FUTO", a **Log in with FUTO** button, and
   a line naming the address it will sign in at.
2. Tap it. Expect the system's own consent alert first — *"FutoNotesNative" Wants to Use
   "…" to Sign In* — then the auth sheet. Approve it.
3. The sheet should finish and dismiss itself, and the wizard move on to **Subscribe to
   FUTO sync** with nothing else tapped.
4. **Subscribe**, approve the consent alert again, let the sheet finish.
5. **Choose a vault password**: type one twice. Expect a strength reading and the
   sentence saying this password is separate from the FUTO password.
6. **Create vault**. Expect the recovery key **once**, seven groups of four, with Copy,
   Share, the plain statement that FUTO cannot recover the vault without it, and a
   toggle that Continue is disabled until you turn on.
7. Turn it on, **Continue**. Expect the account card: the email, the subscription in
   words, storage used, Manage subscription, Change vault password, New recovery key,
   Scan another device, Sign out.

### 2. Sign out keeps the notes

8. **Sign out**, confirm. Expect the sign-in screen back and the notes still in the
   simulator's `Documents/fake-notes`.

### 3. The recovery key gets back in

9. **Log in with FUTO** again. Expect **Unlock your vault** with three doors — no
   subscribe step.
10. **Recovery key**. Type the key in lower case with the dashes left out; the screen
    says dashes and capitals do not matter, so it should mean it. **Unlock** → the
    account card.

### 4. Showing a pairing code

11. From the unlock screen, **Scan from another device** → **Show a pairing code**.
    Expect a QR, a countdown to the relay's own deadline, and Cancel.
12. The code is real and account-scoped: the server's `device_pairings` row should name
    this device and carry a public key, an expiry, and no ciphertext yet.

### 5. Scanning a pairing code

13. From the account card, **Scan another device**. On a **simulator** expect the
    no-camera screen, naming the way through anyway. On a **device**, expect the
    permission ask, then a live preview, then the confirmation sheet naming the other
    device before anything is sent.

## Previous run — 2026-09-16 (`3adf4a54`)

Branch docs/vault-unlock-client at `3adf4a54`, Debug build (`just ios-native`,
`FUTO_IOS_FFI_PROFILE=dev`), simulator `futo-qa-1` (iOS 26.5) on the Mac, Xcode 27.0,
against a real stand-in server on `127.0.0.1:3121` built from the `hosted-server`
branch, stopped by PID afterwards. Driven headlessly over SSH — Xcode 27 has no
Simulator.app.

**1 — brand-new account: PASS.** Both browser steps went through a real
`ASWebAuthenticationSession`: the system consent alert appeared ("FutoNotesNative" Wants
to Use "127.0.0.1" to Sign In / This allows the app and website to share information
about you), and after Continue the sheet completed and dismissed itself and the wizard
was already on the next screen with nothing else tapped. The password screen read
"Strong" for a 16-character password (10% before, 100% after). The recovery key came up
once as `NEE4-B2XN-TCYY-1ASE-78GJ-8907-1M0~`, with Copy, Share, "FUTO cannot recover
your vault without it. Nobody at FUTO has a copy.", "You will not be shown this key
again.", and Continue greyed until the toggle was on. The account card read
`person@standin.test` · `Active` · `0 B of 10 GB used`.

**2 — sign out: PASS.** The confirmation says the notes stay; afterwards `Welcome.md`
was still in the simulator's `Documents/fake-notes` and the screen was back to "Log in
with FUTO".

**3 — recovery key: PASS.** Signing in again went straight to **Unlock your vault** with
three doors. The key typed as `nee4b2xntcyy1ase78gj89071m0~` — lower case, no dashes,
check character included — unlocked the vault and landed on the account card.

**4 — showing a code: PASS.** A QR image with "Time left on this code: 4:55" and
Cancel. The server's `device_pairings` row carried `device_name=futo-qa-1 platform=ios`,
a public key, an expiry five minutes out, and no ciphertext.

**5 — scanning: PARTIAL.** The scanner screen said "This device has no camera / There is
nothing here to read a pairing code with. / You can set the other device up without a
camera: on that device choose "Vault password" and type it." — correct for a simulator,
and the only thing a simulator can show here.

**Accessibility, checked because it is the one string a person must write down:** the
recovery key is exposed as the `AXValue` of an element with the identifier
`hosted-recovery-key`, not only as pixels. A VoiceOver user can read it.

### Not proven by this run

- **A real camera.** A simulator has none, so the scanning half — the confirmation sheet,
  Cancel sending nothing, Send reaching the other device — rests on the injected-string
  path in `just test-ios-native` and on the desktop pairing scenario, which passes the
  payload between two instances as a string.
- **The denied-camera-permission screen**, for the same reason: a simulator has no
  camera to refuse.
- **The vault-password door and Change vault password**, which this run reached through
  the recovery key instead. Both were exercised on a real Android device the same day
  (see the Android story), and both have Swift unit tests.
- **A signed device build.** Code signing over non-interactive SSH fails with
  `errSecInternalComponent`, so everything here is the simulator.

## Last run — 2026-09-16 (`hosted/c1` at `e6f7d313`)

The C1 run, which is about the one thing the previous run could not do: whether
finishing the wizard starts a sync, and whether a relaunch resumes it. Debug build
(`SIM=… just ios-native`, so `FUTO_IOS_FFI_PROFILE=dev`), simulator `futo-qa-2`
(iOS 26.5), against a real stand-in server on `127.0.0.1:3107` from the
`fix/compare-tombstone-redelete-oracle` checkout (contains `origin/hosted-server`),
launched with `SIMCTL_CHILD_FUTO_HOSTED_SERVER`. The second instance was the desktop
Tauri dev app on the same server (`VITE_HOSTED_SYNC=true FUTO_HOSTED_SERVER=… just
tauri-dev`), driven through its webview bridge. Server and worktree devices stopped
afterwards.

**The wizard's end starts a sync: PASS.** A brand-new account walked sign-in → subscribe
→ vault password → recovery key (`W38N-9SW2-ZKW7-19N6-YK64-5NT2-T40N`) → Continue, and
the account card came up reading `person@standin.test` · `Active` ·
**`555 B of 10 GB used`** · **`Sync complete`** — with nothing else tapped. That is the
figure the previous run could only see as `0 B of 10 GB used`.

**A note reaches this device with nothing tapped: PASS.** With the Sync sheet left open
on the account card, a note written on the desktop instance and pushed appeared in the
simulator's `Documents/fake-notes` as `c1-desktop-note.md` within ten seconds, over the
live stream.

**A second device unlocks and syncs: PASS.** After `simctl uninstall` + `keychain reset`
(a genuinely first-run device — see the mechanics note above), signing in went straight
to **Unlock your vault**; the vault password landed on the account card reading
**`1.2 KB of 10 GB used`** · **`Sync complete`**, with all five notes of the account on
disk.

**A restart resumes, with Settings never opened: PASS.** `simctl terminate`, then a note
written on the desktop instance while the app was down, then `simctl launch`. Without
opening Settings or Sync, `c1-ios-restart-proof.md` was on disk and at the top of the
note list within fifteen seconds.

### Not proven by this run

- **Pairing, sign out, Change vault password and New recovery key** were not re-walked;
  the previous run above covers them.
- **A real camera**, as ever.
- **Offline at boot.** The muted line and the keep-the-secrets behaviour are covered by
  `SyncManagerRestoreTests` only; no run has pulled the network out from under a
  launching device.

## Run 3 — 2026-09-16, C12: one sync credential at a time

Simulator `futo-qa-4` (`32D26530-…`, iPhone 17 Pro), debug app `com.futo.notes.dev`,
`just qa-claim ios` → `just qa-release`. **Two** servers, which is what makes the
question answerable: the pinned release in stand-in mode on `127.0.0.1:3131` (hosted,
`just qa-server --standin`) and a password-mode one on `127.0.0.1:3181` (a stand-in for
"my own server", `tests/lib/sync-test-server.mjs`, password `testing123`). Started fresh
with `simctl uninstall` + `simctl keychain reset`.

The oracle throughout is **which server the app holds a socket to** —
`lsof -nP -iTCP:3181 -sTCP:ESTABLISHED` / `…3131…` — because live sync keeps the SSE
stream open. It answers "which vault is this device actually syncing" without trusting a
status string, and it is what a person's notes follow.

**A device that has moved to hosted resumes hosted, not its old server: PASS.** With a
self-hosted password stored (connected once to `:3181`, "Sync complete") and hosted setup
then completed — sign-in consent → **Unlock your vault** → vault password → account card
reading `person@standin.test` · `Active` · **`555 B of 10 GB used`** · `Sync complete` —
the app was force-quit (`simctl terminate`) and relaunched with **both servers running**
and nothing tapped. It connected to **`:3131` only**; `:3181` had no connection at all,
though it was up and would have accepted one. Before the hosted connect, the same binary
on the same device did the opposite: relaunch dialled `:3181` and never `:3131`. Same
build, same device — the stored password is the whole difference, which is what the fix
removes.

**The red state, observed on device.** With the self-hosted server stopped so the
password branch could not succeed, a relaunch connected to neither server and fell
through to nothing — `restoreSession` had already spent itself on the password branch.
That is the reported bug exactly.

### Not proven by this run

- **Android.** The engine rule is shared and its scenario runs against both the stub and
  a real stand-in server, but no Android device walked this story; see
  `docs/qa/hosted-sync-android.md`.
- **A device stranded by an older build** (hosted secrets *and* a password, both already
  saved). Nothing clears its password until a hosted connect runs, which at launch it
  never reaches — so it self-heals only when the sync screen is opened once. Not walked.
- **Switching while connected**, which is now a recorded gap — see the run note below.

### What this run FOUND: switching to hosted while a self-hosted session is live

Walked first, before the passing story above, and it does **not** work. With the
password session connected to `:3181`, the entire hosted wizard ran to a normal-looking
account card — `person@standin.test` · `Active` · `Sync complete` — but storage read
**`0 B of 10 GB used`**, and the next relaunch went back to `:3181`. No hosted cycle had
run: `SyncManager.connectHosted` returns early on
`connected && client != nil && !healing`, and a live *password* session satisfies that
guard exactly as a hosted one does. So the wizard finishes, nothing connects, and the
password is never cleared.

`0 B` versus the `555 B` the same wizard produced once the password session was merely
disconnected is the tell, and it is easy to miss — the card looks finished either way.
Recorded as a gap in `docs/spec/sync.md`; closing it means deciding whether completing
hosted setup should tear down a live self-hosted session, which is a change of specified
intent rather than a gap to close in passing.
