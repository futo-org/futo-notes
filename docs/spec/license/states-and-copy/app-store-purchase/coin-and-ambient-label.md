#### The FUTO coin and the ambient label

- **The FUTO coin** is the one thing a purchase _adds_, on all three platforms:
  a gold coin with the FUTO diamond punched through it, sized 160 inside the
  184 well (CSS px on desktop, pt on iOS, dp on Android) while the state is
  Licensed, and absent — leaving the well empty — in every other state. The well
  is **unpainted space**, not a drawn recess: it reserves the 184 box and carries
  the accessibility label, and nothing is stroked or filled in it on any
  platform. It was a machined recess with an inset-shadow edge until 2026-09-16,
  when @justin asked for the circle border gone on all three; on Android that
  edge had been the entire well. On desktop the well is also **vertically
  centred** against the field column rather than pinned to its top — the coin is
  the only thing on that side, and a circle at the top of a taller column reads
  as having slipped. Its dimensions are the storefront's, ported from lib-polar
  `pylib/futopay_server/static/js/coin-bounce.js` without that file's physics
  world.
  Since 2026-09-16 the coin is **one 3D model, modelled in Blender** by
  `assets/coin/build-coin.py` and rendered by all three shells: a bevelled disc
  with the FUTO diamond punched clean through it, gold face over a darker rim.
  The script exports `futo-coin.glb` (desktop, Android), `futo-coin.usdz` (iOS)
  and `studio-env.hdr`, the small studio every shell reflects off it. **The
  environment is not decoration.** Gold is a metal and a metal renders black with
  nothing to reflect, which is why the coin's materials carry no emissive term
  and why the environment ships as an asset. Android cannot read the `.hdr`
  directly — Filament wants it prefiltered — so `scripts/build-coin-ibl.mjs`
  derives `studio-env-ibl.ktx` from it with a pinned `cmgen`. iOS reads the
  `.hdr` itself, because ImageIO decodes `public.radiance`. →
  `just coin` / `just coin-check`
  Nothing in TypeScript, Swift or Kotlin restates the coin's shape or materials.
  CI has no Blender, so `just coin-check` (in `just check`) proves the cheap
  half: the exports came from the `assets/coin/*.py` sources on disk, no export was
  hand-edited (M8), and the Android cubemap was prefiltered from the `.hdr`
  currently on disk. That last pairing is the one step a person can silently
  skip — a stale cubemap loads fine and just reflects last week's room on one
  platform. → `scripts/check-coin-assets.mjs`
  The flat glyph survives on all three platforms as a **fallback only**, shown
  when the 3D renderer cannot start: desktop's inline SVG, an iOS vector
  imageset, an Android vector drawable (drift concept `supporter-coin-glyph`).
  _(android)_ **"Cannot start" has to be decided BEFORE Filament is handed a
  surface**, because Filament does not fail when a material will not compile on
  the device's driver — it calls `abort()`, and the app dies rather than falling
  back. A licensed user on such a device lost the whole app the moment Settings
  drew the coin (the CI emulator's SwiftShader is one: `Compilation error in
  fragment shader "fxaa"`, then `Fatal signal 6 (SIGABRT) in FEngine::loop`).
  Two guards stand in for the exception there is none of: the driver must report
  **OpenGL ES 3.1** — the one that aborts reports 3.0, the software driver that
  runs Filament reports 3.1, and every device this app supports reports 3.1 or
  better — and the coin **records that it is about to start Filament and clears
  it when a frame comes back**, so a device that killed two renders in a row is
  left on the flat glyph. Two, not one, because a user swiping the app away
  mid-render looks exactly like a driver killing it; and the record is scoped to
  the build that made it, so a new version is always a fresh chance. Desktop and
  iOS need neither: WebGL returns a null context and RealityKit throws, both of
  which are catchable. → _(android)_ `FilamentSupportTest`,
  `SupporterCoinRenderTest` "aDeviceThatCannotRunFilamentGetsTheFlatCoin"
  That glyph is the FUTO diamond — a rounded square on its point, half-diagonal
  0.45 of the disc radius, the same four constants the Blender model uses. Until
  2026-09-16 all three copies carried a hand-drawn path that was a pinched
  figure-eight instead, roughly a quarter of the right width; desktop hid it
  behind its 3D coin, so it was only ever visible on the two native shells. The
  path is now DERIVED rather than drawn, and
  `scripts/check-supporter-coin-glyph.mjs` (in `check:arch-gate`) fails if any of
  the three stops matching it. Being a fallback makes a wrong glyph EASIER to
  ship unnoticed, not harder. →
  `just check` / `node scripts/check-supporter-coin-glyph.mjs --print`
  The coin is not a claim about a date and renders for a v1 activation
  regardless.
  - **Clicking or tapping the coin turns it once around**, fast, on top of
    whatever it was already doing (@justin 2026-09-17; desktop first, both
    native shells 2026-09-18, where the coin had no tap at all). A click or tap
    is a press that moved 5px/dp/pt or less and lasted 400ms or less, so it is a
    drag that went nowhere and never steals a real drag or a flick. **They
    queue: ten taps are ten turns.** What a tap adds is an ANGLE the coin owes —
    paid back fastest when the most is owed, floored so the tail is a coast
    rather than an asymptote, and capped so a burst cannot become a strobe — so
    nothing is ever dropped. The first version held a phase into one half-second
    turn and set it back to zero on each click, which swallowed every click but
    the last (@justin 2026-09-18); it looks perfectly correct on a single tap,
    which is why all three shells' tests were red-proved against it. Distinct
    from the activation celebration, which is a spin-up the decay bleeds off and
    which lands wherever it lands. The constants are part of
    `supporter-coin-motion`. →
    `supporterCoin.test.ts` "turns ten times for ten clicks",
    `tests/license-card.spec.ts` "licensed: clicking the coin spins it a full
    turn" + "licensed: eight fast clicks on the coin queue eight turns";
    _(ios)_ `SupporterCoinTests` "ten taps turn the coin ten times"; _(android)_
    `SupporterCoinTest` "ten taps turn the coin ten times"
  - _(all platforms)_ The coin can be **dragged**: a horizontal drag turns it
    under the pointer or thumb, and releasing while still moving throws it, the
    spin bleeding back to its resting speed. A vertical swipe is left to the
    scrolling surface underneath, so a drag on a phone never traps the sheet.
    The resting speed, decay, drag ratio, flick clamp, tilt and camera framing
    are the same numbers on all three (drift concept `supporter-coin-motion`),
    as is the orientation law: **tilt first, then spin**, so the coin turns on a
    fixed tilted spindle. Composing those the other way swings the spindle and
    the coin wobbles like a dropped hubcap — it renders either way, which is why
    both native shells lock the order in a test. →
    `SupporterCoinTest.kt`, `SupporterCoinTests.swift`
  - _(desktop)_ The coin **turns**: three.js, loaded on demand along with the
    model and the environment, so it costs a non-supporter nothing at startup.
    It spins up once on the moment of activation and settles again, holds still
    under `prefers-reduced-motion: reduce`, stops entirely when scrolled out of
    view or the window is hidden (M5), and falls back to the flat SVG coin where
    WebGL is unavailable or either asset fails to load. Tone mapping is Khronos
    PBR Neutral rather than ACES, which pushes a bright saturated highlight
    toward white and turns the gold sheen grey exactly where it should be most
    golden. The
    spin-up was measured on the real app 2026-09-16, not inferred: per-frame
    pixel motion decays 8.9× from the opening half-second to rest.
    **It is deliberately NOT in the sidebar footer**: that corner sits one
    keystroke from the editor, and a permanent animation beside it is exactly
    the background cost M5 exists to stop. Settings is a surface the user opened
    on purpose and can leave. → `SupporterCoin.svelte`, `supporterCoin.ts`,
    `license.svelte.ts` (`activations`) + `license.svelte.test.ts` "marking the
    moment of activation"
  - _(native shells)_ Both render the same model, at the same one-turn-per-5s
    resting speed. Android uses **Filament** (`gltfio` for the model,
    `KTX1Loader` for the prefiltered studio) in a `TextureView`; iOS uses
    **RealityKit** (`RealityView`, `ImageBasedLightComponent`). Until 2026-09-16
    neither carried a 3D engine: both **projected** the flat glyph twice to fake
    an extruded disc. That was cheap and correct in silhouette, but it could not
    light metal — a shape with a gradient painted on it reads as a sticker
    however accurately it is squeezed.
    Two numbers are deliberately NOT shared, because each renderer scales an
    image-based light differently and the same studio arrives at a different
    brightness in each: Filament's IBL intensity is 4.5 where three.js uses 1.0,
    and RealityKit's intensity exponent is -1.5. Both are **measured**, not
    guessed — each is where the mean colour of the coin's gold pixels lands
    within a few points per channel of the other shells. Filament's tone mapper
    is also set to PBR Neutral for the reason desktop's is; at its ACES default
    the coin read as brushed aluminium.
    Each holds still — as a whole, correct coin — under `prefers-reduced-motion`
    (iOS) and a zero animator scale (Android), falls back to the flat glyph if
    the renderer cannot start, and appears only in Settings, never beside the
    editor (M5). There is no celebrate spin on mobile: activation there does not
    pass through a moment the card is already on screen for. Filament costs
    **18.0 MB of the 55.1 MB release APK** across the three shipped ABIs, of
    which `gltfio` is 8.4 MB; RealityKit is a system framework and costs the iOS
    app nothing. → `apps/ios/Sources/License/SupporterCoin.swift`,
    `apps/android/.../ui/SupporterCoin.kt`
- **Ambient label** (the thing a purchase removes): the text "Unlicensed" when
  Unlicensed or Expired, and **nothing at all** once Licensed — the element is
  removed rather than blanked, because an empty button is still a click target
  and is still announced. **A paid license says nothing outside Settings**
  (@justin 2026-09-21): until then a v2 license read "Licensed since {date}"
  here, which made the reward for paying a permanent line of chrome about
  having paid, sitting one keystroke from the editor — and only for a v2, so
  the v1 that production actually mints already showed nothing and was the
  better of the two states by accident. Every licensed state is now that state,
  `license.licensedSince` is retired, and Settings is the only place in the app
  that mentions the license at all. What is left is informational, never
  interrupts, never appears inside the editor, never on exported or shared
  content, and never on user data (M2).
  - _(desktop)_ The bottom-left corner of the sidebar, and the only thing in
    it — the app version used to share that line and no longer appears there
    at all, because Settings → Updates already reads "Currently running
    v{version}". Clicking it opens Settings at the License card. **The License
    section is the first section of Settings**, above Storage — it used to sit
    near the bottom, after Updates (@justin 2026-09-17), which now puts all
    three platforms in the same place. →
    `src/features/license/SidebarLicenseFooter.svelte`,
    `DrawerSidebar.svelte`, `SettingsScreen.svelte` (`initialSection`),
    `licenseCopy.ts` (`licenseAmbientLabel`) + `tests/license-card.spec.ts`
    "Sidebar ambient license label"
  - _(native shells)_ Mobile has no ambient label outside Settings; the License
    card is the **first thing at the top of Settings**, and in the Licensed
    state nothing on screen names the state at all — the coin in the well says
    it, and the word is available only to assistive technology. → _(ios)_
    `LicenseSettingsSection` as the first `Section` of `SettingsView`,
    `LicenseCopyTests`; _(android)_ `LicenseSettingsSection` as the first group
    of `SettingsScreen`,
    `apps/android/app/src/main/java/com/futo/notes/ui/LicenseSettingsSection.kt`,
    `LicenseCopyTest`
