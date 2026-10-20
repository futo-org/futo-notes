## 1. The decision ledger

| # | Decision | Choice |
|---|---|---|
| D1 | Sequencing | **Editor first, on existing file sync.** CRDT sync is a separate later campaign. Normalize-once churn under text sync is accepted as bounded and self-extinguishing; the conflict-copy machinery catches the rare concurrent-edit collision. |
| D2 | CRDT substrate (on paper now, per ADR-0002's gate) | ~~Tree CRDT, Yjs family (ADR-0003)~~ **Superseded 2026-10-08:** yrs holding the markdown text, owned by Rust — see `docs/plan/crdt-sync-and-sharing.md`. |
| D3 | Foundation | **Productionize `spike/milkdown-editor`**: `@milkdown/kit` core presets + our own chrome (no Crepe). Validated by the perf probe, the 31k-note corpus census, and the working two-shell integration on that branch. |
| D4 | Data-loss bar | **Zero loss is the tracked ideal, not a release gate** (amends ADR-0002's wording). The parked guard work gets finished as ordinary v1 work; the census is a scorecard. |
| D5 | Guard architecture | **Milkdown compat plugin set in `packages/editor`** (root-cause plugin fixes), plus one pre-parse string pass for the bullet-number ambiguity only. Canary tests against upstream; bugs filed upstream. No Rust mirror — recorded M6 carve-out. |
| D6 | Feature parity | **Full bucket-1 parity** with `docs/spec/editor.md` before replacement (see §4). Live-preview/decorated-source spec sections are renegotiated, not matched. |
| D7 | Large notes | **Progressive viewport-first open (7C)**. Open budget redefined as time-to-interactive-first-viewport; saves locked until fully loaded; budgets enforced on a real low-end Android phone (Justin's old device). |
| D8 | Mobile gates | **WebView floor measured** down the Chromium tier ladder, github#8 update-notice below it. **No formal keyboard matrix** — the dogfood period covers IME organically (decided with the risk named). |
| D9 | Rollout | **Dogfood on dev builds, then big-bang three-platform replace.** No CM6 escape-hatch toggle. CM6 and its scaffolding deleted in the same MR chain. Spec renegotiation is its own reviewed MR. |
