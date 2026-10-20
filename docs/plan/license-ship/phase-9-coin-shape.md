## Phase 9 — the coin gets its shape back, and starts turning on mobile — 2026-09-16

@justin, looking at the shipped Android plate: *"the coin isn't spinning. It also
looks wrong."* Both were true, and the second one was the bigger problem.

**The glyph was never the FUTO diamond.** The flat path all three copies carried
was a hand-drawn approximation, and it drew a pinched figure-eight — a sliver
5.2 units wide in the 48-unit box where the diamond is 19.8. Desktop draws the
three.js coin over its copy, so the wrong art was only ever visible on the two
native shells, which is why six QA passes and a release gate went past it. The
path is now DERIVED from the coin's own constants, the same ones
`supporterCoin.ts` extrudes (disc radius 22, diamond half-diagonal 0.45 of it,
corners 0.16), and all three copies carry it.

**`supporter-coin-glyph` is no longer unlocked.** Its registry note argued no gate
could compare an inline SVG path, an `.xcassets` .svg and an Android `<vector>`
pathData for visual equivalence. True in general, false here: the three carry the
byte-identical string and the shape is computable. `scripts/check-supporter-coin-glyph.mjs`
derives it and asserts all three match, runs inside `check:arch-gate` (so `just check`
and CI's mandatory test job), and is red-proved by `one-shell-drawn-a-different-coin`.

**D5 is superseded.** The coin turns on all three platforms now. Neither native
shell gained a 3D engine — they PROJECT the extruded disc instead of modelling
it: two copies of the same glyph, far face in rim gold at −(d·sinθ)/2 and near
face in face gold at +(d·sinθ)/2, each squeezed to |cosθ|. That yields a rim, an
inner wall inside the diamond and a silhouette that narrows to an edge, for the
cost of drawing one asset twice, and it adds no fourth copy of the art.

Two things the first cut got wrong, both caught before device QA by rendering the
projection in a browser first:

- The extruded wall was ramped in as `|sinθ|`, so at 30° it was 50% opaque —
  sitting *behind* the diamond and filling the hole in. It ramps as
  `(1−|cosθ|)⁶` now, which is invisible until the last few degrees, where the
  two faces genuinely stop overlapping. `SupporterCoinTest` locks that law on the
  Kotlin side; the Swift copy is registered as `supporter-coin-projection`,
  partial.
- The edge-on shade was 0.55, which read as muddy brown through mid-turn rather
  than metal. 0.40.

The Android view reads its angle in the DRAW scope, not composition, so a
permanently-running animation invalidates one drawing rather than a subtree.

**Driven on all three, on this commit**, each activated with the staging-signed
fixture pair: *(android)* pooled emulator, five successive frames spanning a full
turn — rim, inner wall and the correct diamond at every angle. *(ios)* pooled
simulator, four frames likewise. *(desktop)* through the webview bridge; the
three.js coin is unchanged (160×160, live canvas, flat SVG hidden), and only its
never-seen WebGL fallback changed shape. `just check`, `just build-android-native`,
`just test-android-native` (both flavors), `just test-ios-native` and
`just gate-redproofs` all green.

`just lint-swift` is red on `apps/ios/Tests/Editor/EditorNavigationDecisionTests.swift`
(141 findings) — pre-existing at HEAD, untouched here; the two License files lint clean.

### Phase 9b — @justin's three corrections, same day

1. **"On all platforms, remove the circle border."** The well was a machined
   recess with an inset-shadow edge, and that edge read as a ring drawn around
   the coin. It is gone on all three: the well is now unpainted space that still
   reserves its 184 box and still carries the accessibility label. On Android the
   inset shadow had been the *entire* well — there was no fill under it — so
   `LicenseWell` now paints nothing at all. Desktop's `--plate-well` token lost
   its last reader and was deleted; iOS keeps `Theme.Plate.recess`, which the key
   field still uses. **Consequence worth naming:** the Unlicensed and Expired
   plates now show empty space where a visible recess used to be. That follows
   from the instruction rather than contradicting it, but if the empty state
   should read as something, it is one fill away.

2. **"On Android, the coin is missing a part — the vertical lines that connect
   the two faces."** Correct, and it was a modelling error, not a tuning one. Two
   horizontally-offset ellipses do not cover their own convex hull: near the top
   and bottom each one tapers to a point, so the silhouette was pinched and the
   faces looked like they were floating apart. The wall is now drawn explicitly
   as the band spanning the gap **minus both faces** — which is exactly the hull
   minus the faces, since the hull is the two ellipses plus that band. Both
   native shells draw it; iOS had the identical defect and was fixed with it.

   This retired the `(1 − |cos θ|)⁶` opacity ramp entirely. That ramp was a
   workaround for a wall of the wrong *shape*: it was hidden at ordinary angles
   because, being a full ellipse, it would otherwise have covered the diamond.
   A wall with the faces subtracted cannot cover the diamond, so it is simply
   drawn, always, at full opacity. `SupporterCoinTest` was rewritten to lock the
   law that survives — where the faces stop covering the centre (85°+, never in
   the turn a user watches) — and the drift entry's patterns and note with it.

3. **"On desktop, vertically center the coin."** `.license-well` is
   `align-self: center` against the plate's `align-items: flex-start`. Measured
   through the bridge: well centre Y 488, plate centre Y 488.

Re-driven on all three after the changes: *(android)* six frames across a full
turn, the edge band now running the coin's full height with no pinch and the
diamond still a hole; *(ios)* six frames likewise; *(desktop)* the plate captured
through the bridge, no ring and the coin on the plate's centre line. `just check`,
both Android flavors' compile + JVM tests, `just test-ios-native` and
`just gate-redproofs` green. The drift gate earned its keep here: it failed the
moment the registry's patterns went stale against the rewritten wall.
