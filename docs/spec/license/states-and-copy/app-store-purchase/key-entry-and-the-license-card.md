#### Key entry and the license card

The key-entry action is **"I already paid"** on every platform, which is what
Grayjay (`i_already_paid`) and FUTO Keyboard (`payment_screen_already_paid_button`)
both call it: it names the person's situation rather than the mechanism. It is
one catalog entry, `license.enterKey`, so all three shells moved together
(@justin 2026-09-18).

- When checkout is available, Buy/Renew is the **only filled button on the
  card** — except _(ios, US)_ beside Buy in the App Store, filled with equal
  weight (§ App Store purchase). Enter license key, Lost your key? and Remove
  license are text links beside it (_(ios, US)_ list rows under the pair). The
  key-only surface has no filled button
  (_(ios)_ Buy in the App Store is outlined there). _(native shells)_ Which controls
  exist at all is Rust's answer, `license_surface_row_actions` (iOS:
  `license_row_actions`), which also owns what each purchase surface hides;
  _(desktop)_ the plate still derives its two buttons inline, because desktop
  is always link-out (drift concept
  `license-row-actions`).
- **The Licensed state wears no badge on any platform**, and neither does
  Unlicensed. The coin in the well is the statement; the word placed over the
  gold "Client license" eyebrow reads as a duplicated eyebrow, which is why iOS
  removed it after seeing it on a device (2026-09-16). Only Expired still names
  itself, because it is the one state that has to explain itself. The state
  stays machine-readable, and since 2026-09-18 that reading hangs off the
  **plate**, not the well — the well now exists only while Licensed, so it could
  not carry a state in two of the three. _(ios)_ `license-plate` carries the
  accessibility value `Licensed` / `Unlicensed` / `Expired`; _(android)_ the
  plate carries the same word as its `stateDescription`. **A QA playbook that
  reads `license-status` must fall back to the plate's value in every state but
  Expired**, where alone a `license-status` chip exists — otherwise it reports a
  false failure. →
  `apps/ios/Sources/License/LicenseSettingsSection.swift`,
  `apps/android/app/src/main/java/com/futo/notes/ui/LicenseSettingsSection.kt`
- **The card shows the stored key masked to its last group** — every character
  before that group replaced by a middle dot, its hyphens left where they are
  (`··-····-····-····-····-····-····-····-RS78` for a key carrying an org
  prefix) — and clicking or tapping it reveals the whole normalized key. **The
  mask is the same length as the key and keeps its separators in the same
  columns**, and every shell renders the value in a monospace face, so revealing
  it is an in-place swap: each dot becomes the character that was hiding under
  it and nothing on the plate moves (@justin 2026-09-18). The first mask was a
  fixed seven groups of dots joined by spaces — 39 characters whatever the key —
  so a 42-character prefixed key slid three cells right as it appeared and took
  the rows under it with it. The masked and revealed states are also the same
  CONTROL rather than a button swapped for a label, because that swap moved the
  rows below by the button's minimum height. _(android)_ **The monospace face is
  bundled, not borrowed**: a phone with a system font theme applied (Motorola
  Styles, and the Samsung/OnePlus equivalents) answers `FontFamily.Monospace` —
  and `android.graphics.Typeface.MONOSPACE` — with a proportional grotesk, so on
  a moto g play running "Rookery" the key was set in the theme font and the plate
  jumped on reveal; Android ships JetBrains Mono NL for this one value
  (2026-09-18). Desktop's CSS monospace stack and iOS's SF Mono are not
  substitutable in this way, so neither bundles a file. **There is no copy affordance on any
  platform**: the revealed key is plain selectable text, and copying it is a
  deliberate select-and-copy, because a license key should not be one click from
  the clipboard (@justin 2026-09-17; desktop first, both native shells
  2026-09-18, which retired `license.card.copyKey` and `license.card.keyCopied`
  along with the two platform clipboard calls).
  **Revealing and copying is local UI, not a rule**: nothing is verified,
  fetched or stored, the reveal lasts only while the card is mounted, and
  leaving Settings re-masks it. The key reaches every shell already normalized,
  on the license view itself, so no shell reads it back out of its own storage
  to display it. → `licenseCopy.test.ts` "masks every group but the last, to
  the key's own length, hyphens included", `tests/license-card.spec.ts` "the
  masked key reveals the full key, with no copy button"; _(ios)_
  `LicenseSurfaceTests` "the card shows the masked key and reveals on tap"; _(android)_ `LicenseSurfaceTest`
  "theCardMasksTheStoredKeyAndRevealsItOnTap" +
  "revealingTheKeyMovesNothingOnThePlate", `LicenseKeyFontTest`
  "everyCharacterTheKeyCanContainIsTheSameWidth"
- Each row pairs a **label with a value**; the arrangement is the platform's.
  _(native shells)_ Every row stacks its label above its value, and _(desktop)_
  the Key row does too — a 39-character monospace key does not fit beside a
  label at phone width, and beside a 184px well it does not fit on a narrow
  desktop pane either. The well itself sits beside the fields on desktop and
  above them on the native shells and on a narrow desktop pane.
- Under the rows, in FUTO's house voice — the app **never** describes itself as
  "free to use", because it is asking to be paid and only declines to force the
  issue. The wording follows Grayjay's `buy_text` and FUTO Keyboard's
  `payment_screen_sales_point_development_body`, which share the mission
  sentence verbatim and neither of which calls its app free:
  - Unlicensed and Expired (`license.explanation`): "FUTO Notes is paid for by
    you, not by ads or by selling your data." (@justin 2026-10-16, the wording
    of the reviewed Settings sketch; it replaced the longer FUTO mission
    paragraph that the siblings share.)
  - Unlicensed **leads with the ask** and puts the reason **above**
    the Buy button, not under it: the headline `license.unlicensedHeadline`
    ("Pay for FUTO Notes"), then the explanation paragraph, then the one filled
    button. Desktop first; both native shells followed 2026-09-18, where the
    explanation had sat below the button — iOS last of all, Android between the
    button and the links. That is the shape all three sibling FUTO-model apps use — Grayjay's
    Buy screen, FUTO Keyboard's Payment screen and Immich's purchase panel are
    each a heading, the reason, one pay button and a way in for someone who has
    already paid — and an argument printed under the button it argues for is a
    footnote (@justin 2026-09-18). **The explanation paragraph is the only
    paragraph.** A second one in the plate's own voice ("Nothing here is locked,
    and a license unlocks nothing — we would rather ask than force the issue.",
    `license.unlicensedPitch`) lived here for one day and went out 2026-09-18
    (@justin): the state now says what it needs in a heading and a paragraph.
    Unlicensed and Expired therefore read identically below the headline — only
    the button's word differs. The app still never calls itself free to use; it
    asks to be paid and declines to force the issue. →
    `tests/license-card.spec.ts` "unlicensed: the ask, no card chrome, Buy as
    the only filled button"; _(ios)_ `LicensePlateTests`
    `testUnlicensedIsAnAskAndActivatingItMakesACard`; _(android)_
    `LicenseSurfaceTest` "unlicensedLeadsWithTheAskAndCarriesNoCardChrome",
    which reads the two elements' geometry rather than trusting source order
  - Licensed (`license.explanationLicensed`), verbatim after FUTO Keyboard's
    `payment_screen_aftersales_paragraph_1`: "Thank you for purchasing FUTO
    Notes." ("paying for" until 2026-09-18, @justin.) One sentence: the second, about continued development, was dropped
    2026-09-16 (plan D7) when the card replaced the row.
    → all three shells select the key off the state: `LicenseSettingsSection`
    in `src/features/license/`, `apps/ios/Sources/License/`, and
    `apps/android/app/src/main/java/com/futo/notes/ui/`
- **Renew** is the Buy action; a new key simply replaces the old one.
- **Remove license** asks for no confirmation (it is reversible by re-entering
  the key) and returns the device to Unlicensed. It exists for testing and
  device hand-off.
- No state ever shows a price, a countdown, a nag, or a banner. There is no
  pre-expiry notice outside the card's own "Valid until" term.
