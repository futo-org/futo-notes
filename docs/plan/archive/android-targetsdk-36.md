# Android targetSdk 36 — completed migration

The app now sets compileSdk and targetSdk to 36 in `apps/android/app/build.gradle.kts`.
The August 25 migration kept compileSdk unchanged and verified edge-to-edge layout,
predictive back, keyboard insets, and large-screen resize behavior on a claimed API 36
emulator. Builds, JVM tests, three instrumentation tests, and `just check` passed in
that recorded run; this is historical evidence, not a fresh device pass.

With the WebView focused, back first dismissed the IME, then returned to the list
with dirty content persisted. Reset/moving-note overlays blocked navigation. Rotation
and resize preserved an unsaved note with no horizontal overflow.

Release follow-up: check the All Files Access declaration independently of the SDK
migration; store submission remains governed by the release procedure.

## Separate follow-ups recorded in the original plan

The dated platform-policy statements below are planning context. Recheck official
requirements before implementing either SDK 37 change.


- **compileSdk 37** — Android 17 is stable (2026-06-16), AGP requirement met. Safe but
  noisy (new lint/deprecations); do as its own commit after the deadline pressure is off.
- **targetSdk 37** (Play deadline ~Aug 2027) — real work, not a number flip: the
  `ACCESS_LOCAL_NETWORK` runtime permission becomes enforced. Hits our supported
  self-hosted/LAN sync path directly; without the permission UDP fails `EPERM` and TCP
  *times out* (looks like "server down", not "permission denied"). Open question to settle
  early on an Android 17 device: whether 100.64.0.0/10 (Tailscale/CGNAT) counts as
  local network — the Android 16 behavior-changes page lists it, the dedicated
  local-network-permission doc doesn't enumerate ranges. If it counts, our own prod
  server over Tailscale needs the permission for every user of that path. Design notes
  from the 2026-08-25 session: prompt only when the configured URL resolves local (avoid
  scaring HTTPS-only users), handle the silent-reconnect path (`SyncManager.restoreSession`
  can't show a dialog), distinguish permission-denial from network failure in
  `describe(e)` (possibly via NDK `android_getnetworkblockedreason()` through FFI), and
  reuse the All Files Access settings-deep-link recovery pattern (`MainActivity.kt:762`).


## Original plan and evidence

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/plan/android-targetsdk-36.md
```
