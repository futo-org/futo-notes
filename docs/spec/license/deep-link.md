## Deep link

- The scheme is **`futonotes`** on all three platforms: iOS `CFBundleURLTypes`,
  Android an exported `VIEW`/`BROWSABLE` intent filter on the main activity,
  desktop the Tauri deep-link plugin on Linux, macOS and Windows (the Tauri
  shell is desktop-only). → _(desktop)_ `tauri-plugin-deep-link` with
  `plugins.deep-link.desktop.schemes` in `tauri.conf.json`, `license::install`;
  a second launch carrying the link arrives through the single-instance plugin's
  argv (`license::handle_single_instance_arguments`). _(ios)_ `CFBundleURLTypes`
  in `apps/ios/Info.plist`, delivered by `.onOpenURL` on the root view. →
  `LicenseSurfaceTests` "the app registers the crate's URL scheme" (asserts the
  shipped plist against the crate's `licenseDeepLinkScheme()`),
  `LicenseModel.handle`. Dev
  builds register the same scheme; whichever build the OS routes to will verify
  against its own key, so a production link opened by a dev build fails cleanly
  as Invalid.
- Only the path `license/{key}/{activation}` is defined. Any other host or path
  is ignored silently. That verdict is the crate's on every platform, never a
  shell's. → `license::parse_deep_link`, _(ios)_ the `Ignored` arm of
  `licenseHandleDeepLink`, `LicenseModelTests` "an undefined link is ignored
  silently"; _(android)_ the same `Ignored` arm in `LicenseModel.handle`,
  `LicenseModelTest` "anUndefinedLinkIsIgnoredSilently" — driven on the emulator
  as `am start -d futonotes://settings/open`, which left the screen
  byte-identical
- A valid link **replaces** an existing license without confirmation and shows
  the "License activated" toast. An invalid link shows one toast, "This license
  link isn't valid", and changes nothing. No dialog, no navigation; if Settings
  is open its License card updates in place.
- A link arriving while the app is cold-starting is handled after the shell is
  interactive (M1): the shell renders first, then applies the link. _(ios)_
  SwiftUI hands a launch URL to `.onOpenURL` only once the root view exists, and
  the toast rides the transient banner the note list already mounts, so a
  cold-start link is applied and announced on a painted screen. →
  `apps/ios/Sources/App/FutoNotesApp.swift`, `LicenseModel.handle`; a message
  produced before the app has wired up its banner is parked and flushed the
  moment it has one, so the toast survives even the earliest launch URL. →
  `LicenseModelTests` "a cold-start link is announced once the banner exists".
  The stored pair is read and RSA-verified away from the main actor after the
  shell renders; a link or other newer action prevents that startup result from
  replacing it. → `LicenseModel.load`, `stateRevision`
  _(android)_ The launch intent's URL is parked in Compose state during
  `onCreate` and applied by a `LaunchedEffect` after the first composition, so
  the note list _shell_ is painted before the link lands and the toast appears on
  it. Measured frame by frame on the emulator 2026-09-10 (#160, 20 fps
  screenrecord): splash to 3.90s, the shell — top bar, icons, FAB — paints at
  3.95s, the toast begins fading in at 4.05s **after** it, and the note **rows**
  arrive at 4.95s, so the toast rides an empty list for ~0.9s while the vault
  scan finishes. That is M1's intended shape (a scan may delay content, never the
  shell) and is the same empty window a plain launch shows; the toast never lands
  on the splash or a blank window;
  the same state carries a link from `onNewIntent`, so both deliveries take one
  path, and a launch intent is consumed once — a recreation that re-delivers it
  does not re-announce a license the user already has. The stored pair is read
  _and verified_ off the main thread (M1), and that answer is not allowed to
  overwrite a license the link applied while it was in flight. →
  `apps/android/app/src/main/java/com/futo/notes/MainActivity.kt`
  (`pendingLicenseLink`), `LicenseModel.load`/`applyEvaluated`, `LicenseModelTest`
  "aLinkAppliedBeforeTheStoredPairLandsSurvivesIt"
  _(desktop)_ Rust applies and _parks_ the outcome — storing blocks no render — and the shell
  drains it once it has painted, so the toast is delivered exactly once whether
  the link arrived before or after the webview existed. The asynchronous startup
  snapshot is revision-guarded, so it cannot overwrite the drained outcome. →
  `license::LicenseLinkInbox`, `license_take_pending_link`,
  `license::tests::a_parked_link_outcome_is_delivered_exactly_once`,
  `license.svelte.test.ts` "does not let the startup snapshot overwrite a license"

- **Landing after activation** _(ios, android)_. When an activation succeeds (deep link,
  cold or warm; or a key or pair entered on the card) and the license now
  includes the app icon, the `license.activated` toast still shows, Settings is
  presented if it is not already, and the App icon picker opens over it with a
  one-time header above the grid: the coin, `license.explanationLicensed` in
  bold, and `settings.appIcon.license.landing` under it.
- The `license.activated` toast is shown inside the picker presentation, over the
  grid, so the user sees it during the landing (a banner on the screen beneath
  the picker would be hidden by it). It is shown once.
- The landing happens only if it can be presented at the moment of activation: no
  other modal covers the note list, and no Settings-owned sheet or dialog (Sync,
  Full reset) is up. Otherwise it is dropped on the spot and the toast alone
  shows; a pending landing is never kept for a later Settings visit.
- The header exists only for that presentation: dismissing the picker and
  reopening shows the plain grid. Nothing is persisted; there is no "seen" flag.
- If the picker is already open (the user bought from its sheet, or typed a key
  after "I already paid"), the sheet dismisses itself and the grid re-renders
  licensed with the same header.
- A cold-start link applies after the shell has painted; the picker is
  presented after, never gating the shell.
- If the OS cannot change icons (`supportsAlternateIcons == false`) the landing
  is skipped entirely.
- _(android)_ Settings is a screen on the navigation stack, not a sheet: from
  the note list, a folder, a note or Search it is pushed and opens the picker;
  already on Settings, the picker opens over it. On Sync, Storage location or
  Feedback (screens Settings owns), under the crash-report dialog, or with no
  shell yet (first-run storage choice), the landing is dropped and the toast
  alone shows. The toast is a system toast, so it shows over the picker. →
  `LicenseLanding.kt`, `LicenseLandingTest`, `AppIconLandingTest`
- _(desktop)_ The toast alone is the landing: there is no picker to land on.
