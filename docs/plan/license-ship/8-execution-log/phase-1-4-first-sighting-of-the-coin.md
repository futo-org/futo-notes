### Phase 1.4 — first sighting of the coin — 2026-09-16

First real render of `SupporterCoin.svelte` (WIP `08a31503`) in the desktop
app. Driven through the Tauri MCP bridge on a `.dev` build
(`com.futo.notes.verify.s21.dev`), never OS-level input. Activated with the
staging-signed fixture pair from `apps/ios/Tests/License/LicenseFixture.swift`
(key `FN-AB12-...-RS78` + its v2 activation, the same pair used by the native
suites), entered as a `key/activation` pair via `license_enter_key` — this
verifies offline against the baked `STAGING_PUBLIC_KEY_BASE64`, no network
call. Both the raw Rust command and, for the activation-transition test, the
app's own live `license` model singleton (imported by its already-loaded
module URL, so `license.activations` genuinely incremented through the real
reactive path) were used.

**Verdict: WORKS.** The coin is not blank, not broken, and not a placeholder.

- **Renders**: `buildCoin()` succeeds — `supporter-coin-stage-live` class is
  present, `canvas.getContext('webgl2')` is live and `isContextLost() ===
  false`. Visually it is unambiguously a gold disc with the FUTO diamond
  punched through it (a real cutout — confirmed by seeing through it to the
  page background when the coin turns edge-on), sitting in a ~96×95 CSS-px
  circle inside the License card's ~104–122px-tall row. Screenshots:
  `test-screenshots/desktop-license-coin-light-3.png` (light),
  `desktop-license-coin-dark.png` (dark), `desktop-license-unlicensed.png`
  (pre-activation state — correctly shows no coin, "Buy a license").
- **Spins**: confirmed once with a clean two-frame capture 600ms apart while
  the window was genuinely visible/focused
  (`coin-visible-crop-a.png`→`coin-visible-crop-b.png`, non-empty pixel diff,
  edge-on→face-on rotation). Every other capture in this session — including
  several deliberate attempts at the celebrate-on-activation boost — came back
  pixel-identical, but `document.visibilityState`/`hasFocus()` were `hidden`/
  `false` at every one of those attempts: this is the documented single-display,
  multi-parallel-session confound (`references/desktop.md` "Parallel sessions
  steal focus back within seconds" — several other QA/dev sessions were live on
  this same Mac throughout), not a coin defect. WebKit suspends rAF while
  occluded, which is exactly what was observed. I could not get a
  discardable-free capture of the `celebrate()` fast-spin (`CELEBRATION_SPIN =
  16` vs base `1.25`) specifically, only of the base idle spin — but the
  activation transition itself is proven live (`license.activations` 0→1
  through the real model, `<SupporterCoin celebrate={license.activations}>` is
  correctly wired, no console/window errors during a clean single-activation
  cycle).
- **Light/dark**: both render correctly; dark theme keeps the same gold/near-
  black coin on the dark card, no contrast or clipping problems.
- **Console**: no three.js/WebGL errors in any clean run (console.error/warn
  and window `error`/`unhandledrejection` hooked for the whole session).
- **Caveat, not a coin bug**: mid-session, a parallel lane's concurrent edits
  to `LicenseSettingsSection.svelte`/`licenseCopy.ts`/`languages/en.json` in
  this same worktree (visible in `git status` throughout — Phase 2/3 work in
  flight) triggered one Vite HMR crash (`SyntaxError: Importing binding name
  'licenseRowText' is not found`, `Failed to reload
  .../LicenseSettingsSection.svelte`), which briefly showed the raw
  i18n key `license.supporterSince` instead of interpolated copy. A clean dev
  restart showed correct "Licensed since Jan 15, 2026" copy — this was HMR
  fallout from a moving working tree, not a product bug, and is not a Gap.

Commands/checks: manual bridge session only (no automated test added — this
was a first-look sighting, not a regression check). Screenshots under
`test-screenshots/` (gitignored, not committed — paths above).

Phase 4 should know: the coin itself is solid and ready to build the card
around. The one open question this pass couldn't close cleanly is whether the
celebrate boost is visually distinct enough from idle spin in practice —
worth a deliberate single-observer check (no parallel QA contention) before
sign-off, since this pass only proved idle spin and the activation-state
transition, not the two composed together on screen.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
