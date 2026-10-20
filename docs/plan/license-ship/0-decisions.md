## 0. Decisions (locked — do not reopen without @justin)

| # | Decision | Value |
|---|---|---|
| D1 | Card treatment, all three platforms | **Steel Ledger** plate: one container (the plate is the card), gunmetal gradient, gold accent, a 184px circular **well** with an inset shadow and **no ring/outline**, present in every state; a 160px coin sits in it when Licensed, the well is empty otherwise. |
| D2 | Date line vs v1 reality | Ship with the "since" row implemented but **blank for v1** activations (production mints v1 today, so no real buyer sees a date until FUTOpay serves v2). No release is blocked on v2. |
| D3 | Wording of the dated line | **"Licensed since {date}"**, full localized date, never a bare year. Replaces "Supporter since {year}" everywhere (spec, catalog, three shells, footer). |
| D4 | License key on the card | **Shown masked**; click/tap reveals the full key and offers Copy. |
| D5 | Mobile | iOS and Android get the **same plate card** (native SwiftUI / Compose). ~~with a **static** coin. Only desktop animates.~~ ~~The native shells project the extruded disc rather than modelling it, so neither needed a 3D engine.~~ **Superseded twice on 2026-09-16 by @justin**: the coin turns on all three platforms, and all three now render ONE Blender model (`assets/coin/`) rather than each faking a 3D coin their own way — Android through Filament, iOS through RealityKit, desktop through three.js. The projection could not light metal. See docs/spec/license.md § The FUTO coin. |
| D6 | Unlicensed/Expired paragraph | Unchanged: `license.explanation` (the FUTO mission sentence). |
| D7 | Licensed paragraph | `license.explanationLicensed` = **"Thank you for paying for FUTO Notes."** (one sentence; the second sentence is removed). |
| D8 | Buy button | Unchanged: "Buy a license"; Expired says "Renew". |
| D9 | Store posture | ~~Unchanged from 2026-09-09: Buy link ships worldwide on iOS and both Android flavors, `LICENSE_LINK_OUT` true.~~ **Superseded 2026-09-24** by ADR-0005 and `docs/plan/license-store-compliance.md`. |
| D10 | Fonts | No new font files. Barlow 400/500/600/700 are bundled (`src/styles/fonts.css`); the mock's Barlow Condensed becomes Barlow 700 uppercase with tracking, and the mock's JetBrains Mono key value uses the platform's system monospace stack. |
| D11 | Rows on the card | **Key**, **Licensed since**, **Term**. The mock's "Verified · ED25519" row is dropped (it is wrong: verification is RSA-SHA256, and the spec forbids the client describing the mechanism). |

Assumptions the implementer may take without asking (flag them in the MR):

- Eyebrow above the product name reads "Client license"; the product name line reads "FUTO Notes". Both are catalog entries even though one is a brand name.
- Term row values: "Perpetual" when `expires_at` is null **or** the activation is v1 (the spec states a v1 license is perpetual by format, so this is not an invented date); "Valid until {date}" when `expires_at` is set and in the future; "Expired {date}" in the Expired state.
- The masked key shows only the **last group**: seven groups of four middle dots then the real last four characters, e.g. `···· ···· ···· ···· ···· ···· ···· 6UJV`. Reveal lasts while the card is mounted; leaving Settings re-masks.
