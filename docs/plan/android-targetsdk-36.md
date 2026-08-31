# Plan: Android targetSdk 35 → 36

**Worktree:** `~/Developer/futo-notes-android-target36` · branch `chore/android-targetsdk-36`
**Why now:** Google Play requires new apps and app updates to target API 36 (Android 16)
starting **2026-08-31** (extension available to 2026-11-01 via Play Console). Below-target
apps aren't removed, but updates can't be published and the app stops surfacing for users
on Android versions above the target.
**Decided (session 2026-08-25):** targetSdk → 36 now, minimum diff. compileSdk stays 36
(already there). compileSdk 37 and targetSdk 37 are separate later efforts — see §6.

## 1. The code change

`apps/android/app/build.gradle.kts`:

- Line 46: `targetSdk = 35` → `targetSdk = 36`.
- Lines 19–25: rewrite the block comment. It currently explains why targetSdk
  *deliberately stays at 35*; after this change that reasoning is false. New comment should
  say: compileSdk 36 is the androidx floor, targetSdk 36 is the Play requirement as of
  2026-08-31, and name the behavior changes we accepted (edge-to-edge mandatory,
  predictive back default, large-screen orientation ignored — §2).
- Line 33: the NDK comment says "16 KB page-size support for targetSdk 35+" — still true
  at 36, no change needed, but re-read it while editing the neighborhood.

No manifest changes: we don't use `windowOptOutEdgeToEdgeEnforcement`,
`screenOrientation`, `resizeableActivity`, or aspect-ratio attributes (verified by grep
2026-08-25). No dependency bumps required: AGP 8.11.1 / Gradle 8.14.3 / Kotlin 2.0.20 /
Compose BOM 2025.09.01 / activity 1.12.4 all handle compileSdk 36 already (this stack has
been compiling against 36 since the edge-to-edge work).

## 2. What targeting 36 turns on, and why we believe each is safe

Assessed against the code 2026-08-25 (session notes). Each row is a claim to *verify in
§4*, not a reason to skip verification.

| Android 16 change | Our exposure | Basis |
| --- | --- | --- |
| Edge-to-edge mandatory (opt-out attr dead) | Expected no-op | Already `enableEdgeToEdge()` (`MainActivity.kt:175`) + inset handling (`NoteEditorScreen.kt:705–714`, `imePadding`) since the edge-to-edge/16KB work landed on main 2026-07-07 |
| Predictive back default; `onBackPressed()` never called, `KEYCODE_BACK` never dispatched | Verified no-op | All back handling is androidx `BackHandler` (`AppNavigation.kt:111`, `NoteEditorScreen.kt:418`, empty blockers `MainActivity.kt:254`, `SettingsScreen.kt:286`) — dispatcher-based and unaffected. API 36 device QA verified the WebView-focused and IME paths (§4). |
| Orientation/resizability ignored on ≥600dp screens | Low risk | We never lock orientation; activity declares `configChanges="orientation|screenSize|keyboardHidden|uiMode"` and handles rotation itself |
| `scheduleAtFixedRate` runs ≤1 missed execution | N/A | No usage; sync polling is coroutine-based |
| 16 KB page sizes | Done | NDK 28.2.13676358 pinned since the 16KB work |
| Health/BT-bond/intent-matching/MediaStore-version changes | N/A | Nothing declared or used |
| Photo picker pre-selects app-owned media under limited access | N/A-ish | Image flow is TakePicture + FileProvider, vault is direct-path I/O under All Files Access, not MediaStore |

## 3. Order of work

1. Rewrite comment + flip the number (one commit, `build(android):` type; body cites the
   Play deadline and a `Verified:` line per repo convention).
2. Local build + unit chain (§4 steps 1–2).
3. Device QA on an **Android 16** image (§4 step 3) — the behavior changes only manifest
   on Android 16 devices, so a pass on the API-30 AVD proves nothing about them.
4. MR + CI. No release-gate change needed (M14: no new test job).
5. Before the Play submission itself: §5 console check.

## 4. Verification (AGENTS.md §7.7 owner chain — apps/android/AGENTS.md)

1. `just build-android-native` — compile sanity (rebuilds Rust bindings first, M9).
2. `just test-android-native` — JVM unit tests.
3. Device QA on an **API 36 emulator or Android 16 device** (note: the editor-capable AVD
   table in memory says `futo-api30` is the editor-capable emulator — check whether an
   API 36 AVD with a modern WebView exists before assuming; a physical Android 16 device
   may be the realistic path):
   - **Edge-to-edge:** open a note, keyboard up — editor toolbar sits above the IME, no
     content under status/nav bars, gesture-nav device. This is the most likely subtle
     regression.
   - **Predictive back:** back-swipe from editor → list (dirty-note flush still runs),
     from Settings and from sync screen; verify the empty `BackHandler {}` blockers still
     block. Do one back-swipe *while the editor WebView has focus* to answer the open
     question in §2.
   - **Large screen:** tablet/foldable or resizable-emulator: rotate + resize with an
     unsaved note open; no state loss, no stretched layout.
   - Storage stories if anything smells off: `just test-android-storage` (claims a pool
     device, clears app data — never a personal phone).
4. `just check` before MR (7.10).

Execution result (2026-08-25): all local checks passed on the claimed
`futo-qa-2` API 36 emulator (`emulator-5554`, Android 16, gesture navigation), and the
installed package reported `targetSdk=36`.

- `just build-android-native` and `just test-android-native` passed with freshly generated
  Rust/Kotlin bindings for all three Android ABIs.
- `ANDROID_SERIAL=emulator-5554 just test-android-native-ui` passed all 3 instrumentation
  tests.
- With the WebView focused, the first back-swipe dismissed the IME and a subsequent
  back-swipe returned to the list; the dirty marker was present in the vault file. Settings
  returned to the list and Sync returned to Settings. Back-swipes delivered while the reset
  and moving-notes overlays were active left Settings underneath each blocker.
- The editor toolbar remained above the IME with clear status/navigation insets. On a
  ≥600dp resized display, rotating and resizing an open dirty note preserved the editor and
  its content; DOM measurements showed a centered editor column and no horizontal overflow.
- `just check` passed, including the Rust/TypeScript conformance locks, 1,649 unit tests,
  379 editor tests, Svelte/type/format checks, architecture gates, and the production build.

## 5. Play Console — independent risk on the same submission

Every Play release re-runs the **All Files Access (`MANAGE_EXTERNAL_STORAGE`) declaration
review**. If the declaration isn't current, the update stalls for policy reasons and looks
like the SDK bump failed. Check the declaration in the console *before* tagging the
release that carries this change. (Manifest rationale for the permission is documented in
`AndroidManifest.xml` — the vault must be a user-visible path-addressable folder; same
justification Obsidian uses.)

## 6. Explicitly out of scope (planned follow-ups, not this branch)

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

## Sources

- [Play target API requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
- [Behavior changes: apps targeting Android 16](https://developer.android.com/about/versions/16/behavior-changes-16)
- [Behavior changes: apps targeting Android 17](https://developer.android.com/about/versions/17/behavior-changes-17)
- [Local network permission](https://developer.android.com/privacy-and-security/local-network-permission)
