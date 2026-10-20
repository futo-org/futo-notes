### Phase 5 (iOS) — native plate — DONE 2026-09-16

The Phase 2 stopgap (one line of `badge`) is gone; `apps/ios` renders the Steel
Ledger plate. Two commits: `feat(license): build the Steel Ledger plate on iOS`
(3f6fe33f) and `fix(license): match the iOS plate's licensed state to the other
two shells` (7256f725), the second entirely driven by what the simulator showed.

**What the plate is, in SwiftUI.** One `Section` (still the first in
`SettingsView`), one row, `.listRowInsets(EdgeInsets())` +
`.listRowBackground(Color.clear)` so the plate *replaces* the grouped-row
background instead of sitting inside one. The plate is a `VStack` with
`.padding(22)` on a `RoundedRectangle(cornerRadius: 12, style: .continuous)`
filled with `Theme.Plate.gradient`.

**The well and its inset shadow — the one thing worth copying.** SwiftUI has
had an inner shadow since iOS 16, as a *ShapeStyle* modifier, and it is exactly
the CSS `box-shadow: inset`:

```swift
static var recess: some ShapeStyle {
    bottom
        .shadow(.inner(color: wellShadow,    radius: 6, y: 2))   // rgba(0,0,0,.28)
        .shadow(.inner(color: wellHighlight, radius: 0, y: -1))  // rgba(255,255,255,.35)
}
…
Circle().fill(Theme.Plate.recess).frame(width: 184, height: 184)
```

No `.stroke`, no `.overlay(Circle().stroke(…).blur(…).mask(…))` — the usual
SwiftUI "inner shadow" trick is a blurred stroke, and a stroke is the one thing
D1 forbids. The same `recess` is reused as the key field's background, which is
why the field reads as part of the plate rather than a UIKit control dropped on
it. Tokens are `Theme.Plate` in `apps/ios/Sources/App/Theme.swift`: the §5
Phase 4 table's six pairs through `Color.adaptive`, plus the two shadow colours
(fixed rgba, identical in both themes, as the mock has them).

**Two deviations from the §5 structure, both forced by phone width:**

1. **The well stacks ABOVE the fields**, not beside them. A 184pt well plus a
   fields column does not fit 402pt minus margins. The plate is therefore
   vertical everywhere on iOS; no `ViewThatFits`, because there is no iOS width
   where the horizontal form fits and the extra layout pass is not free.
2. **Each ledger row puts its label above its value.** The key is 39 characters
   in *both* forms (`···· ×7 + last group` is the same length as
   `FN-AB12-…-RS78`), which no phone-width two-column row can hold. Rows are
   `LABEL` in dim uppercase caption2 over the value, separated by a 1pt
   `Plate.rule` hairline. It reads as a ledger and the revealed key fits on one
   line at 13pt monospace with no scaling.

**Licensed shows no status chip** — corrected after seeing it. The first build
rendered `license.statusLicensed` there so that `license-status` existed in
every state, and on screen it was a second gold uppercase line directly above
the gold `CLIENT LICENSE` eyebrow: it read as a duplicated eyebrow, and neither
desktop nor Android renders anything there. The chip is now Unlicensed/Expired
only. **The state is still machine-readable in every state**, from the one
element the plate always has: `license-well` carries
`.accessibilityValue(statusName)` → `Licensed` / `Unlicensed` / `Expired`, with
its label being `license.coinAccessibilityLabel` or `license.card.emptyWell`.
QA playbooks that read `license-status` must fall back to `license-well`'s
value in the Licensed state.

**Accessibility identifiers**: all eight existing ones kept
(`license-status`, `license-buy`, `license-renew`, `license-enter-key`,
`license-lost-key`, `license-remove`, `license-key-field`, `license-activate`,
`license-cancel-entry`), plus `license-key-masked`, `license-key-copy` and
`license-well`.

**`Image(decorative: "SupporterCoin")`, not `Image("SupporterCoin")`.** The
plain form hands VoiceOver the **asset name** as the image's label — a
developer string in no catalog — and it was visible in the simulator's
accessibility tree as a child of the well even though the well is
`.accessibilityElement(children: .ignore)` with its own catalog label.
`decorative:` removes the node entirely; verified before/after on the device.
Android's `Image(painterResource(...), contentDescription = null)` has the same
hazard and presumably already handles it; desktop's inline SVG does not.

**Copy** writes `UIPasteboard.general.string` and confirms through
`LicenseModel.announce`, which stopped being `private` for exactly this: the
Copy toast rides the same parked/banner path as `license.activated` and the two
error messages, so the card never grows a second toast mechanism.

**Test**: `LicenseSurfaceTests` gained "the card shows the masked key and
reveals on tap" against `licenseKeyRowText(_:key:revealed:)`, a free function
in `LicenseSettingsSection.swift` so the reveal rule is assertable without
hosting a SwiftUI view. It pins: masked ≠ containing the key, revealed == the
stored key verbatim, no key row at all when unlicensed, and a licensed card
whose key went missing staying masked.

**`ThemeSwitchTests` needed a scroll.** The plate is taller than a phone screen
has to spare, so the Appearance picker starts below the fold — and an
off-screen `Form` row is not in the accessibility tree *at all*, so the old
unconditional `app.buttons["Dark"].tap()` failed with "No matches found". It
now swipes up until `Dark` is hittable. This is the first visible cost of the
plate's height and Phase 7 should expect it in any Settings story.

#### Commands and results

```
just build-rust-ios                 → exit 0
SIM=… just test-ios-native          → ** TEST SUCCEEDED ** (exit 0)
                                      167 tests in 29 suites, 0 failures
                                      + 4 UI tests, 0 failures
just lint-swift                     → exit 1, 161 errors — the SAME 161, in the
                                      same 4 files, that origin/main already
                                      has (EditorWebView 11, NoteEditorView 8,
                                      EditorNavigationDecisionTests 141,
                                      FeedbackImagesTests 1). Measured by
                                      linting a `git archive origin/main`
                                      checkout: 161 there, 161 here. This
                                      branch's own footprint is zero — the one
                                      branch-introduced error
                                      (LicenseModelTests.swift:239, a 101-char
                                      #expect from an earlier license commit)
                                      is fixed in 7256f725.
SIM=… just ios-native               → BUILD SUCCEEDED, installed, launched
```

`just lint-swift` cannot be made green by this phase without reformatting four
unrelated files; that is a separate cleanup, not a license change.

#### What the device actually showed (futo-qa-1, iPhone 17 Pro sim, 402×874pt)

Driven with `axe` + `scripts/describe-ios-ui.mjs`; states changed with
`xcrun simctl openurl` carrying the staging fixture from
`apps/ios/Tests/License/LicenseFixture.swift`, which verifies offline against
the baked `STAGING_PUBLIC_KEY_BASE64` on the `.dev` build. Screenshots in
`test-screenshots/` (gitignored, not committed).

- **Unlicensed, light** (`ios-license-unlicensed-light.png`) and **dark**
  (`ios-license-unlicensed-dark.png`): the plate reads as one object. Gold
  `UNLICENSED` capsule, gold `CLIENT LICENSE` eyebrow, `FUTO NOTES` in bold
  uppercase, the three ledger rows all present with blank values, the orange
  filled `Buy a license`, then `Enter license key` / `Lost your key?` as gold
  text buttons, then the mission paragraph. The empty well is unmistakably a
  recess in both themes — dark rim at the top, light rim at the bottom, no ring
  anywhere. In dark the white inner highlight along the bottom of the well is
  what sells it; in light it is subtler but still concave.
- **Licensed, light** (`ios-license-licensed-light.png`) and **dark**
  (`ios-license-licensed-dark.png`): the gold coin sits 160pt inside the 184pt
  well with a visible ring of recess around it. No status chip. `KEY` shows
  `···· … RS78`, `LICENSED SINCE Jan 15, 2026`, `TERM Valid until Jan 15,
  2029`, `Remove license` as the only action, and "Thank you for paying for
  FUTO Notes."
- **Reveal and copy** (`ios-license-revealed-dark.png`): tapping
  `license-key-masked` swaps the row to
  `FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78` in monospace on one line, with a
  `Copy key` button under it. Tapping it showed the `License key copied` banner
  and `xcrun simctl pbpaste` returned that exact string — the normalized key,
  nothing else.
- **v1 activation** (`ios-license-licensed-v1-light.png`): `LICENSED SINCE` is
  present and **blank**, `TERM Perpetual`. D2 holds on the device.
- **Remove** (`ios-license-after-remove-dark.png`): back to Unlicensed, well
  empty, reveal gone.
- **Key entry** (`ios-license-entry-dark.png`): the field renders inside the
  plate in the same recess as the well, `Activate` disabled at 0.5 opacity
  while empty, `Cancel` beside it. Typing `key/v1Activation` and tapping
  Activate produced Licensed — the field path works end to end, not just the
  deep link.

#### Two findings Phase 6/7 should have

1. **Expired could not be reached on the simulator, and that is an
   environment limit, not a code one.** The only staging-signed fixture in the
   repo expires 2029-01-15, and there is no way to move an iOS simulator's
   clock: `xcrun simctl` has no time subcommand, and `simctl spawn <udid>
   /bin/date` fails because the iOS runtime has no such binary. The 2026-09-10
   Expired sighting in `docs/spec/license.md` was on the **Android emulator**
   (`adb shell date`), where it is trivial. Reaching it on iOS needs either the
   host Mac's clock moved — refused here: parallel sessions, and it breaks TLS
   and signing — or a staging-signed activation minted with a past
   `expires_at`, which needs the staging private key (`FUTO_NOTES_STAGING_KEY`,
   not in this repo). The Expired *plate* is therefore covered on iOS only by
   `LicenseCopyTests` (badge, `Expired {date}` term, the no-dates fallback) and
   the `licenseRowActions` golden (Renew · Enter key · Lost your key?); its
   rendering has never been seen on an iPhone. **Phase 7 should mint one
   expired staging activation once and add it to `LicenseFixture` — it unblocks
   the Expired story on all three platforms permanently.**
2. **The iOS keyboard corrupts a *typed* `key/activation` pair, and the app
   correctly rejects it.** Typing the v2 pair with `axe type` produced
   `…kDmB0–BVuWux…` — the system keyboard's smart-dash substitution turned the
   activation's `--` into an en dash — and the card showed "This license key
   isn't valid". That is the right answer to a corrupted signature, and it is
   not reachable by the documented flow (users paste, and paste does not go
   through text substitution; the deep link and a paste both activated the same
   pair in this session). But note that `.autocorrectionDisabled()` does **not**
   disable smart dashes, SwiftUI exposes no modifier that does, and the user
   would get no hint why. Worth a spec line under Entering a key rather than a
   Gap: **only paste or the deep link, never hand-typing, is a supported way to
   enter an activation.** Not recorded as a gap here — one tool's keyboard is
   not a product verdict (M21).

Also for Phase 6: the spec's § States and copy still says the iOS row's status
text IS the platform's ambient label. That is now only true for Unlicensed and
Expired; in the Licensed state iOS names the state nowhere visible — the coin
is the statement, as on desktop and Android — and the word is available only to
assistive technology through the well. Say so explicitly, because it is the one
place where "the card shows the state" stopped being literally true.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
