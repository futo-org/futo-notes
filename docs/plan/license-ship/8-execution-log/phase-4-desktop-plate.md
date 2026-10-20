### Phase 4 — desktop plate — DONE 2026-09-16

The Steel Ledger plate replaces the status row in Settings → License. Two
commits: `feat(license): build the Steel Ledger plate on desktop` (e48650fb) and
`fix(license): stop the plate's key row collapsing into a 96px-tall label`
(daa0c5c7), the second found by looking at the real app rather than at a test.

**What shipped** (`src/features/license/LicenseSettingsSection.svelte`). The
structure is §5 Phase 4's, with one deviation noted below: `.license-plate`
(gradient, 12px radius, 22px/24px padding, wrapping flex row, gap 24px) →
`.license-well` (184px, inset shadow, no ring) + `.license-fields` (badge,
eyebrow, `FUTO NOTES`, `dl.license-rows`, the one filled Buy/Renew slab, the
existing key-entry field, the explanation, the links). Palette exactly as the
plan's table, as component-scoped custom properties redefined under
`:global([data-theme='dark']) .license-plate`, plus one token the table did not
list: `--plate-well` (`#c6ced6` / `#161b20`), so the recess reads as a hole
rather than only as a shadow. **Nothing on the plate transitions a
theme-dependent property**; the only `transition` is `transform` on the button
press.

`SidebarLicenseFooter.svelte` needed no logic change — `licenseAmbientLabel`
already said "Licensed since {date}" from Phase 2 — only its two comments that
still cited the removed "Supporter since {year}" copy.

**Deviations from §5 Phase 4, both deliberate:**

- **The Key row is stacked (label above value), not a two-column row.** Beside a
  184px well the fields column is ~304px and the label column 96px, leaving
  ~196px for a 39-character mask. Letting the row wrap "when it has to" was the
  first attempt and it overflowed the plate by 20px at the wrap boundary and
  32px at 300px of plate. Stacking that one row is unconditional and cannot
  overflow. The other two rows are the plain label/value pair the plan drew.
- **No `letter-spacing` on the key.** 0.04em put the mask at 308px in a 304px
  column — two lines for four pixels.

**Rules the plan set, and where each is enforced:** reveal is component-local
`$state` and resets on unmount (observed: closing and reopening Settings
re-masks); Copy goes through `getPlatformFS().writeClipboardText` (the
platform-discipline gate would reject the plugin import) and toasts
`license.card.keyCopied`; the filled Buy/Renew slab keeps `--color-primary` and
is the only filled button in every state (asserted in the spec); the gold accent
is the rules, the badge border and the in-plate links only; every string is an
existing §2 catalog entry read through `localizedText` — **no catalog entry was
added or changed in this phase**.

**Tests.** `license.svelte.test.ts` was not touched: no model behavior changed,
and Phase 2 had already added `key` to both of its `LicenseView` literals. New
`tests/license-card.spec.ts`, 5 cases: unlicensed / licensed v2 / licensed v1 /
expired / reveal+Copy. It mocks the platform license module by **fulfilling the
dev server's request for `/src/lib/platform/license.ts`** with a stand-in
module (`page.route('**/src/lib/platform/license.ts*')`) — there was no existing
Playwright mocking precedent in `tests/`, and this needs no product-code test
hook. The mock is proven effective by the licensed/expired cases, which the real
module (which answers Unlicensed for everything off Tauri) could never produce.
No CI change: `test:e2e:rest` is a `--grep-invert` over all specs, so the file
joins it automatically and `release:gate.needs` is untouched (M14).

**Verification, all from the worktree, exit status checked directly (M11):**

```
just build                                        → exit 0
just test-one src/features/license                → 2 files, 32 tests passed (exit 0)
pnpm run test:e2e:smoke                           → 2 passed (exit 0)
pnpm exec playwright test tests/license-card.spec.ts → 5 passed (exit 0)
just check-theme-single-pace                      → OK (exit 0)
just check-platform-discipline                    → OK — 10 allowlisted, 0 unsanctioned (exit 0)
pnpm run check:languages                          → Validated 2 language catalogs (exit 0)
pnpm run check:svelte                             → 0 errors, 0 warnings
pnpm run lint                                     → 0 errors, 4 pre-existing warnings
pnpm run format:check                             → exit 0
```

**Seen for real.** Driven on this worktree's dev Tauri build
(`com.futo.notes.verify.s21.dev`, `FUTO_NOTES_DATA_DIR=.tauri-data`) through the
MCP bridge's raw WebSocket on the port `scripts/qa-target.mjs port 9244`
verified as this worktree's own debug binary. No OS-level input at any point
(M24). Screenshots in `test-screenshots/` (gitignored, not committed):
`plate-{licensed,unlicensed,expired}-{light,dark}.png`,
`plate-licensed-revealed-light.png`, `plate-narrow-licensed-light.png`.

- **Licensed** (real staging fixture, entered as `key/activation` through the
  live model — verifies offline against `STAGING_PUBLIC_KEY_BASE64`): no badge,
  the coin turning in the well at a measured **160×160 inside 184×184**, WebGL2
  context live, `Key ···· … RS78`, `Licensed since Jan 15, 2026`,
  `Term Valid until Jan 15, 2029`, "Thank you for paying for FUTO Notes.",
  Remove license as the only link, **zero** filled buttons, footer
  "Licensed since Jan 15, 2026".
- **Unlicensed** (reached by clicking the real Remove): gold `UNLICENSED` badge,
  empty well labelled "No license", all three rows present and blank, one filled
  "Buy a license", Enter license key + Lost your key?, footer "Unlicensed".
- **Expired**: `EXPIRED` badge, `Licensed since Jan 2, 2024`,
  `Term Expired Jan 2, 2025`, filled "Renew", no Remove, footer "Unlicensed".
  **This state was reached by setting `license.view` on the live model, not by a
  real activation** — no staging-signed activation with a past expiry exists and
  the private key is not in this repo. Rust's expiry verdict has its own tests;
  only the rendering was observed here. Phase 7 cannot do better on desktop
  either.
- **Reveal and Copy**: the masked button (accessible name "Show key") reveals the
  full key and swaps in "Copy key"; clicking it toasted "License key copied" and
  the exact normalized key `FN-AB12-…-RS78` (42 chars) was on the system
  pasteboard afterwards. The app cannot read the clipboard back
  (`clipboard-manager:allow-read-text` is deliberately not granted), so the
  read-back was done outside the app. **Side effect worth knowing: this
  overwrites the machine's clipboard.**
- **Narrow**: the window cannot be resized from the webview
  (`core:window:allow-set-size` is not granted and was not added for QA), and the
  plate has no viewport media query — it reacts only to the width its parent
  gives it, so the Settings panel's `max-width` was constrained instead, which is
  the same input a narrow window supplies. Swept 600→320: **no horizontal
  overflow of the plate or the document at any width**; the well stacks above the
  fields from ~510px of plate down; the mask is one line everywhere except the
  ~520px band and below 340px, where it wraps cleanly.

**Celebrate spin — PROVEN, contention-free.** What Phase 1.4 could not close is
closed. The window was raised by launching a second copy of this worktree's own
debug binary (single-instance focus) and kept raised for the run; a per-`rAF`
sampler drew the coin canvas into a 48×48 scratch 2D canvas and summed the
per-frame pixel delta, with `document.visibilityState` recorded on every sample.
Activation was the real path (`license.enterKey(key/activation)` on the live
model → `ok: true`, state `licensed`, `activations` 0→1, 15ms in).

```
frames sampled 354   visible on 355/355 samples   canvas up at t+67ms
mean per-frame delta   0–500ms   67485
                     500–1000ms   35421
                       1–2s       13721
                       3–4s        7589   ← resting
```

An **8.9× decay** from the opening half-second to the resting band, which is
what `CELEBRATION_SPIN = 16` bleeding off at `SPIN_DECAY = 2.6` toward
`BASE_SPIN = 1.25` predicts. No sample was taken while the window was hidden, so
the Phase 1.4 occlusion confound does not apply. **There is no Gap here and none
should be recorded.**

**What Phase 5 should copy or avoid:**

- Copy the row model: label above value for the key, label beside value for the
  other two. Both native shells have the same 184px-well-versus-text squeeze.
- Copy "every row is present in every state, blank when there is no value". It
  is what makes Unlicensed and a v1 license look deliberate rather than broken.
- Avoid a stacked row that inherits a cross-axis basis — the SwiftUI/Compose
  equivalent of the `flex-basis` trap is a fixed label *width* that becomes a
  fixed *height* when the stack turns vertical.
- The masked key is 39 characters. Size the field for it, do not truncate it.

**What Phase 6 must write into the spec** (this phase saw it on screen):

- The Licensed state shows **no badge** on desktop; the coin in the well is the
  statement. Unlicensed and Expired wear the badge.
- The desktop card shows the stored key masked to its last group, reveals it on
  click, and offers Copy. Reveal is local UI with no rule and no persistence:
  leaving Settings re-masks (verified).
- The ambient footer reads "Licensed since Jan 15, 2026" when licensed with a
  date, "Unlicensed" when unlicensed **or expired**, and nothing at all for a v1
  license.
- "only desktop turns" is accurate and now measured: the coin idles at ~1.25
  rad/s and spins up ~13× on the activation that crosses into licensed, decaying
  back within ~2s.
- The Expired state remains **unobservable from a real activation** on every
  platform until FUTOpay mints an expiring product; say so if the spec's Expired
  lines are ever read as verified-on-device.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
