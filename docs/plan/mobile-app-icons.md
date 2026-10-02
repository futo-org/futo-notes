# Selectable app icons on iOS and Android

Status: implemented in the icons branch, 2026-10-02; Android emulator checks and
video are complete. iOS build, simulator checks, and video remain pending because
`justins-macbook-pro` is offline on Tailscale. This is not yet merged or shipped.

## Result

Add a small **App icon** section to native Settings. Its row shows the current
icon thumbnail and name. Tapping opens a native sheet with six labeled previews.
Tapping a preview applies that icon immediately, with a checkmark on the actual
selection. Keep the sheet open so users can compare choices; Done/Back or a swipe
returns to Settings. There is no Save step or additional app confirmation.

The icon choice belongs to this installation and is independent of the app's
Light/Dark/Auto theme. Both platforms can implement it with native APIs and
bundled assets; no Rust, UniFFI, editor bridge, server, or synced-preference work
is needed.

Two platform details qualify “immediately”: Apple displays its own notification
alert after an icon change, and Android launchers may take time to refresh the
visible icon. We should use the supported APIs and preserve those system behaviors.
[Apple alternate-icon guide](https://developer.apple.com/documentation/xcode/configuring-your-app-to-use-alternate-app-icons),
[Android PackageManager reference](https://developer.android.com/reference/android/content/pm/PackageManager).

## The six choices and their sources

The supplied [branding page](https://www.figma.com/design/aRkXaG6PNHotvdR1fnZ4xW/FUTO-Notes---Branding?node-id=326-500)
contains the named frames below. Metadata and the page screenshot were inspected;
Light / Standard also returned design context successfully.

| Stable choice ID | Picker label     | Source                                                         | Appearance                                |
| ---------------- | ---------------- | -------------------------------------------------------------- | ----------------------------------------- |
| `light-standard` | Light / Standard | Existing primary icon; Figma `329:961` is the design reference | Orange mole on a light background         |
| `light-reversed` | Light / Reversed | Figma `328:581`                                                | White mole on orange                      |
| `dark-standard`  | Dark / Standard  | Figma `329:972`                                                | Orange mole on a dark background          |
| `dark-reversed`  | Dark / Reversed  | Figma `329:974`                                                | Dark mole on orange                       |
| `futo`           | FUTO             | Figma `335:6`                                                  | White mole on FUTO's dark blue background |
| `website`        | Website          | The adjacent `../futo.tech` project card composition           | Website logo with its scanline treatment  |

The separate Figma Transparent frame (`329:983`) is not a seventh choice.

Keep the existing Light / Standard primary artwork for this feature. The current
[icon.png](../../assets/images/icon.png) differs slightly from the Figma frame
in scale and effects; adopting all of the latest default artwork would be a
separate visual change. Generate a faithful preview of the existing default.

The website option is a composed visual, not just an SVG:

- `../futo.tech/src/routes/projects/-projects.ts` maps FUTO Notes to
  `logoFutonotes`.
- `../futo.tech/src/assets/logos/logo-futonotes.svg` contains the colored tile.
  Use this asset rather than the separate monochrome `brand-futonotes.svg`.
- `ProjectCard` in `../futo.tech/src/routes/projects/index.tsx` puts the logo in
  a 64px square wrapper with `scanlines-sm`, border, background, and glow.
- `../futo.tech/src/styles/styles.css` defines the scanlines: white for 2px,
  transparent for 4px, repeating every 6px, at 0.09 opacity with overlay blending.
  The surrounding wrapper uses the website's neutral-blue tokens.

Bake the visible square tile and scanlines into artwork. Launcher icons cannot
run CSS. Capture an isolated website tile as the visual reference, avoiding
unrelated page-wide overlays; preserve its normalized stripe spacing when
exporting at 1024px. Exclude the outside-page glow and let each OS supply the
outer icon mask. Compare the result at actual launcher sizes: thin scanlines
need visual review after downsampling.

## Settings and sheet behavior

Place the App icon section directly after Appearance. Use the existing native
section and row styling, with the thumbnail, selected name, and disclosure affordance.
The sheet has an **App icon** title, native navigation chrome, and a scrollable
two-column grid that adapts to narrow screens, tablets, and large text. Each
cell is a button containing a preview, a label, and a selected checkmark.

While the OS request is running, show progress and disable additional choices.
Tapping the selected choice is a no-op. Mark the new selection only after
success/readback; on failure retain the actual selection and display a localized
error. Expose the name and selected state to VoiceOver/TalkBack, support large
text, and use native minimum touch targets. Dismissing the sheet does not undo
a completed change.

All authored labels, names, errors, and accessibility text go under a new
`settings.appIcon` namespace in [languages/en.json](../../languages/en.json),
accessed through each platform's `localizedText`. Reuse existing Done/Back copy.
English entries suffice; platform language resources remain generated.

On iOS, Settings already uses a `NavigationStack` inside a sheet and presents
Sync as another sheet. Add an App icon sheet with its own `NavigationStack`,
inline title, and Done button following that pattern.

Android Settings currently uses a full-screen `Scaffold` and pushes its Sync
and Storage screens. For this requested picker, use Material 3
`ModalBottomSheet`, initially expanded, with the existing `TopBar` and a Back
button that dismisses it. The sheet must own system/predictive Back and swipe
dismissal: closing it leaves Settings and its navigation stack intact. Test
this explicitly against the earlier overlay/Back trap recorded in
[nav.md](../spec/nav.md). There is only one page inside this sheet, so it needs
no new global `Screen` route or navigation library.

## iOS implementation

Owner: `apps/ios/Sources/Settings/AppIcon/`, containing a small icon definition,
native controller, and picker view. Wire presentation from
[SettingsView.swift](../../apps/ios/Sources/Settings/SettingsView.swift).

1. Keep `AppIcon` as the primary asset set. Add five alternate `.appiconset`
   catalogs, with stable names such as `AppIconLightReversed`,
   `AppIconDarkStandard`, `AppIconDarkReversed`, `AppIconFuto`, and
   `AppIconWebsite`. Supply opaque square artwork without baked outer rounded
   corners. Provide ordinary image sets for picker thumbnails: launcher icon
   catalogs are not ordinary SwiftUI `Image` resources.
2. Set `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES` to those five names in
   [project.yml](../../apps/ios/project.yml). Keep
   `ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon`. Xcode's asset compiler generates
   the alternate-icon plist entries; do not hand-edit the generated Xcode project
   or duplicate its `CFBundleIcons` dictionaries in the source plist.
   [Apple configuration guide](https://developer.apple.com/documentation/xcode/configuring-your-app-to-use-alternate-app-icons).
3. Use `UIApplication.shared.supportsAlternateIcons` to determine availability,
   `alternateIconName` to read the actual selection, and
   `setAlternateIconName` to change it. Pass `nil` for Light / Standard.
   Handle completion errors and update UI on the main actor. No separate
   `@AppStorage` selection is needed; re-read on presentation and when the app
   becomes active. [Apple API](<https://developer.apple.com/documentation/uikit/uiapplication/setalternateiconname(_:completionhandler:)>).
4. Keep Apple's change alert. A silent change is not part of this plan. If the
   platform reports alternate icons unsupported, keep the current preview
   visible and show a localized unavailable state instead of offering broken taps.
5. Verify the built app includes all five alternates for both iPhone and iPad
   (`TARGETED_DEVICE_FAMILY` is `1,2`; deployment target is iOS 18). Inspect both
   generic and iPad icon metadata where emitted; older Apple plist guidance
   warns that iPad alternate entries do not fall back to generic entries.
   [Apple plist reference](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html).

The six labels identify artwork, not automatic iOS Light/Dark/Tinted variants.
Keep manual selection independent of appearance; validate the OS's own icon
styles without promising exact colors under system tinting.
[Apple app-icon guide](https://developer.apple.com/documentation/xcode/configuring-your-app-icon).

## Android implementation

Owner: `apps/android/app/src/main/java/com/futo/notes/ui/settings/appicon/`,
containing the small icon definition, PackageManager controller, and Compose
sheet. Wire it from
[SettingsScreen.kt](../../apps/android/app/src/main/java/com/futo/notes/ui/SettingsScreen.kt).

1. Add six permanent `activity-alias` entries after `.MainActivity` in
   [AndroidManifest.xml](../../apps/android/app/src/main/AndroidManifest.xml).
   Each targets the same real activity, has its own adaptive `android:icon`,
   uses `${appLabel}`, is exported, and declares MAIN/LAUNCHER. Only the default
   alias is enabled in the manifest. Move the current MAIN/LAUNCHER filter off
   MainActivity. Keep MainActivity itself enabled, with its existing
   `singleTop`, license deep-link filter, configuration handling, and editor
   lifecycle. [Android alias documentation](https://developer.android.com/guide/topics/manifest/activity-alias-element).
2. Give each choice adaptive foreground/background assets; put the mark in the
   66dp safe region of the 108dp layers. Preserve gradients, reversed colors,
   and the website scanlines in the generated layers. Do not embed an outer
   rounded-square mask. Keep the existing omission of `roundIcon`: the manifest
   documents a previous undersized rendering bug from the legacy round bitmap.
   Supply monochrome layers for themed-icon support and use color previews in
   the picker. System themed icons can recolor the selected design and suppress
   its color/texture distinctions. [Android adaptive icon guide](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive).
3. Read actual selection from PackageManager, resolving
   `COMPONENT_ENABLED_STATE_DEFAULT` using each manifest default. Construct
   `ComponentName` with the installed package ID and stable alias class name;
   debug `.dev` and release must both work. Alias names need no Kotlin classes.
4. On API 33+, use `setComponentEnabledSettings` to switch all aliases as one
   atomic batch, with `DONT_KILL_APP` consistently applied. On API 28–32,
   enable the requested alias first, then disable the others. Never leave the
   app without a launcher entry, and never disable MainActivity. Catch errors,
   read back actual state, and attempt to restore the prior single selection if
   the older multi-call path fails. If a process stops between calls, reconcile
   multiple enabled aliases when next observed; this recovery must not blindly
   overwrite a valid single selection on startup. PackageManager is the
   selection authority, so no preference needs to be synchronized with it.
   [PackageManager API](https://developer.android.com/reference/android/content/pm/PackageManager).
5. Keep alias names stable in future releases. Verify in-place upgrades from
   today's MainActivity launcher entry, plus upgrades with every new alternate
   selected. Changing launcher component identity can affect existing home
   placements; establish actual behavior before accepting this implementation.
   Do not force launcher refresh by killing processes or restart the app as part
   of selecting an icon. `DONT_KILL_APP` is a request, not proof that every
   launcher/task behaves identically.

This lives in the common `main` source set; direct and Play builds behave
identically. Existing explicit launch tooling (`apps/android/run.sh`,
`tests/lib/android/adbClient.mjs`, `tests/lib/android-device.mjs`) addresses the
real MainActivity, which remains enabled. Check those paths and deep links;
also test launching through the selected alias, since explicit launches cannot
prove launcher behavior.

## Asset ownership and implementation order

1. **Prove platform packaging and switching first.** Bundle one alternate per
   platform and exercise primary → alternate → primary. Check iPad packaging
   and Android existing-install upgrade/home placement before building all UI.
2. **Prepare the six artworks.** Store new canonical source artwork under
   `assets/images/app-icons/`, preserving Figma node/source provenance. Copy the
   required website artwork/treatment into this repo; builds must not depend on
   the sibling checkout or temporary Figma asset URLs. Fetch full design context
   for each alternate frame before exporting it. Do not redraw the branding.
3. **Generate platform outputs and previews together.** No existing tracked
   mobile icon generator was found in this inspection. Add one small, documented
   deterministic asset-generation command if needed, using an existing suitable
   image tool. Keep output paths explicit, regenerate only these assets, and
   preserve the current default geometry. Read `scripts/AGENTS.md` before adding
   tooling. New icon-source files should not be embedded-raster wrappers like
   the existing `assets/images/icon.svg`.
4. **Finish the native controllers and sheets.** Reuse existing native controls;
   use simple platform-specific mappings, not a cross-platform settings framework.
   Keep catalog names/alias IDs permanent and exercise real failure handling.
5. **Record implemented behavior.** Update `docs/spec/settings.md`,
   `settings-visual.md`, and `nav.md` with the mobile-only section, local choice,
   sheet dismissal/Back behavior, and platform alert/refresh limits. The current
   visual spec's blanket shared-capabilities wording needs an explicit mobile
   icon exception under the user's requested scope. This plan does not claim
   that behavior already ships.

Full reset needs an explicit integration decision: deleting app preferences does
not clear an OS-managed launcher choice. Recommended behavior is to request
Light / Standard as part of a confirmed reset, report an icon-reset failure,
and preserve the existing stop-sync-before-wipe ordering. Do not add alternate
icon changes to credential clearing or storage migration. Cover the agreed
reset behavior in the spec and a regression test during implementation.

## Verification and completion

Every logic change gets an owning-layer test. Unit coverage should include
default mapping, same-choice no-op, success/failure state, overlapping requests,
and Android DEFAULT resolution and older-API transition/recovery. A small fake
OS boundary is enough; verify the actual API separately on devices. Check the
packaged assets and metadata for every selectable name, rather than only testing
an enum against itself. Use existing test targets/gates; any new CI job must
also enter `release:gate.needs`.

Required implementation checks:

- `pnpm run check:languages`.
- `just build-ios-native` and `just test-ios-native` on a Mac with Xcode.
- `just build-android-native` and `just test-android-native` for both flavors.
- `just test-android-native-ui` on a claimed emulator/device, including sheet
  Back/dismissal and selection semantics.
- `just check` before merge.

Device acceptance must show the actual launcher, not only Settings thumbnails:

- Select all six, return to primary, tap the current choice, and try fast taps.
- Reopen Settings, force-stop/relaunch, reboot, and install an update over the
  existing build; confirm the current selection and a working launcher entry.
- iPhone and iPad: native alert, icon appearances, large text, VoiceOver, and
  the App Library/Home Screen.
- Android API 28–32 and 33+: exactly one enabled alias after success; existing
  home placement, app drawer, recent-task reentry, deep links, and Pixel plus
  Samsung/another OEM launcher. Include themed icons and launcher masks.
- Both: localized labels, light/dark sheet appearance, error UI, and a debug
  install alongside production without changing production's icon or data.

Inspect release build artifacts as well as debug builds; do not publish or tag
to test this feature. This Linux workstation cannot run the iOS chain locally.

The work is medium-sized and primarily native UI plus assets. Android launcher
upgrade behavior and small-size scanline rendering are the main uncertainties;
the initial platform proof resolves them before the full picker is assembled.
