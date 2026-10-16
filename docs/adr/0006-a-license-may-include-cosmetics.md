# A license may include purely cosmetic choices

Approved by @justin and FUTO's CEO on 2026-10-15.

Until now the spec's first principle was "Nothing is gated": a license changed the ambient
label and the License card and nothing else, and a requested "cosmetic" feature that non-payers
would want was ruled a gate by another name. That rule also forbade the one thing FUTO wants to
offer: choosing the app icon. The principle becomes **"Nothing that works is gated."** Every
working feature stays available without a license. What a license buys is the thing that costs
FUTO recurring money (sync) and the **purely cosmetic** choices FUTO decides to include.

Plan: [`docs/plan/license-cosmetics.md`](../plan/license-cosmetics.md). Behavioral truth:
`docs/spec/license.md` § What a license includes, `docs/spec/settings.md` § Native app icons.

## Decisions

| # | Decision |
|---|---|
| D1 | Today a license includes **choosing the app icon**: all six existing choices. Standard is the default every install has, not a "free tier". No seventh, licensee-only icon. |
| D2 | The gate is on choosing, never on keeping. A removed or expired license leaves the icon set; only Full reset changes it, to Standard. |
| D3 | Expired does not include the icons: Unlicensed with a story, asking "Renew" where Buy would be. |
| D4 | The ask appears only where the user walked in: the picker (badges, footnote, sheet) and the Settings row hint. Never on launch, never a popup, never in the editor or the list. |
| D5 | Vocabulary: "included with a license", "comes with a license", and "unlock(s)" for what a license includes (cosmetics), allowed by @justin 2026-10-16 on link-out builds only; key-only builds (App Store 3.1.1) keep "included with a license". Never "paywall", "premium"; "free" and "donate" stay banned. |
| D6 | Store posture is unchanged ([ADR-0005](0005-license-purchase-follows-store-rules.md)). Key-only builds get `license.keyOnlyExplanation` and "I already paid": no Buy, no website. |
| D7 | Desktop has no picker, so no visible change; it still projects the Rust rule. |
| D8 | Rust owns the rule (`license_includes`), projected through UniFFI and Tauri. No Swift/Kotlin/TS copy. |
| D9 | The spec principle is rewritten, in the same change as the Rust rule. |
| D10 | License sync (carrying the license inside the vault) is its own change, after approval; it touches the sync payload. |
| D11 | Picker: coin badges on every tile but the current one, one footnote, a sheet on tap. An ask card inside the picker was rejected. |
| D12 | The License card does not change. |
| D13 | Once licensed, the coin stays on every icon but Standard, so the picker shows which came with the license. |

## Consequences

- **The inclusion rule** future cosmetics must meet: the app is whole without it, the default is
  a complete product, and the gate is on choosing, never keeping. Themes are the likely next
  candidate. A working feature, limit, or data-safety behavior is never included.
- **ADR-0005's review argument weakens.** Its option A defends the key field outside the US on
  the grounds that the license "unlocks nothing". A license now includes icon choice, so that
  sentence is no longer literally true. Guideline 3.1.1 names license keys as an unlock
  mechanism; before the next store submission re-read it, and keep the argument to "unlocks
  no functionality". Option B (a non-consumable IAP) remains the fallback.
- **Attribution.** The Buy URL gains a `from` parameter (`license-card`, `app-icon`) that rides
  the click the user already makes: no new request, nothing stored.
- The deep-link activation lands the user in the icon picker, on native only.
