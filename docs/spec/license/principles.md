## Principles

- **Nothing that works is gated.** Every feature the app has works identically
  licensed or not; a license never takes one away and never turns one on. What a
  license includes beyond the ambient label and the License card is **purely
  cosmetic** choices FUTO decides to include (today the app icon), and the thing
  that costs FUTO recurring money to run (sync). The inclusion rule: a license
  may include a choice only if the app is whole without it, the unchosen default
  is a complete product rather than a "free tier", and the gate is on
  _choosing_, never on _keeping_ (below). Never add a licensed-only feature or
  limit. Decided with @justin and FUTO's CEO 2026-10-15 (ADR-0006), replacing
  "Nothing is gated", which also forbade cosmetics.
- **It is a purchase, never a donation.** Copy says "license", "buy", "renew".
  The word "donate" never appears in the product or the store listing. (Stores
  treat donations differently and enforce against donation links; FUTO is not a
  nonprofit, so the word would also be inaccurate.) The rule scopes to shipped
  copy, not to this spec: naming the forbidden word in order to forbid it is
  what makes the rule checkable.
- **Price lives only in Polar and on the web.** The client never displays,
  fetches, or hardcodes a price. The Buy action opens the web checkout; the
  price is seen there.
- **Rust owns the rule.** Parsing, verification, expiry, deep-link parsing, and
  the single activation network call live in one Rust crate,
  `futo-notes-license`, projected through Tauri and UniFFI. Shells own only UI,
  URL-scheme registration, and preference storage (AGENTS.md §4.1, §4.6). No
  Swift, Kotlin, or TypeScript copy of any license rule.
- **Zero background network.** The license module contacts the network only on
  an explicit user action (entering a bare key). It never validates on launch,
  never polls, never phones home. Offline-first and privacy win over revocation.
- **Attribution rides the click the user already makes.** The Buy URL carries
  `platform` and `from` (which surface the user tapped Buy on: `license-card` or
  `app-icon`). That is the whole of it: no new request, nothing stored, nothing
  sent without a tap. _(desktop, ios, android)_ → `buy_url`, `BuySource`
- **Typing is sacred (M5).** License state is read once into reactive state; no
  per-keystroke or per-render verification.
