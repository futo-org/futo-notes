## Appearance

- A theme change (Light/Dark/Auto, including the OS moving under Auto) repaints
  every surface in the same frame. No surface fades, springs or cross-fades to
  its new color while the rest of the window snaps.
  → scripts/check-theme-single-pace.mjs
- A color transition may only cover a property whose rest value cannot carry a
  theme color (`transparent`, `none`), so the animated value is reachable only
  under `:hover`/`:active` — states an unattended theme change never enters
  _(desktop)_. → src/styles/sidebar-header.css
- Top bars take their background from `TopBar`, never Material3's
  `TopAppBar` container color, which Material runs through
  `animateColorAsState` _(Android)_. →
  apps/android/app/src/main/java/com/futo/notes/ui/components/TopBar.kt
- The theme is applied by overriding the scene's windows
  (`overrideUserInterfaceStyle`), never a root `.preferredColorScheme`: the
  latter leaves an already-presented sheet on its old appearance entirely
  _(iOS)_. → apps/ios/Sources/App/Theme.swift `appearanceOverride`

> **Gap:** _(iOS)_ A stock toolbar button's pill background — Settings' **Done**
> — repaints on UIKit's own later pass, so it trails the rest of the sheet.
> Measured on an iPhone 17 Pro simulator (iOS 26) by tapping Light/Dark and
> sampling frames: every sheet surface reaches its new color in the same single
> frame, while the pill is ~29% of the way there. Reproduced with the app's tint
> replaced by a stock system color, so this is platform chrome rather than FUTO
> theming, and there is no app-side fix.
