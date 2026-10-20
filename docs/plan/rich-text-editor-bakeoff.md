# Rich-Text Editor Bake-off — Five Approaches, One Contract

> **Status: WRAPPED 2026-08-25 — P1 is the sole graduate; P2/P3/P4/P5 were
> killed by their predeclared metrics. Both exhaustive existing-editor baselines
> and the non-causal Step 0 census are complete. Long post-verdict/current-HEAD
> characterizations were stopped without aggregates at Justin's request after
> host contention made the six-hour jobs impractical; §12 records the bounded
> next work. Criteria below were fixed before any experiment ran.** Created
> 2026-08-24 from a design discussion with Justin.
> The goal is a rich-text editing experience that keeps this project's
> file-over-app promise: the user's markdown file stays authoritative, and the
> app never tells them their markdown is formatted weird.
>
> **Update 2026-08-27: the Tier-3 "diff discipline" criterion (§1) and the §4
> rejection-without-probe of Milkdown/Lexical are SUPERSEDED by
> `docs/adr/0002-roundtrip-normalization-accepted.md` (Justin) — round-trip
> normalization is now acceptable, so tree-owned editors are back on the
> table. Do not cite this doc to block that work. Tiers 1–2 (never refuse,
> never warn — extended by the ADR to never LOSE content) still bind, as does
> the ADR's one-serializer-everywhere rule. The verdicts and measurements
> below remain valid historical evidence under the criteria as they stood.**
>
> This is a sibling of `docs/plan/editor-decision.md` (the native-vs-CM6
> decision, DEFERRED 2026-07-17 — CM6 ships everywhere for now). This doc does
> NOT reopen that decision. Approach 5 below overlaps with it; if Approach 5
> graduates, the result feeds that parked decision as new evidence. Unparking
> it is Justin's call, not an agent's (AGENTS.md §11.5 — changing specified
> intent).

- [1. The requirement (the contract every approach is scored against)](rich-text-editor-bakeoff/1-the-requirement.md)
- [2. The reframe that shapes everything](rich-text-editor-bakeoff/2-the-reframe.md)
- [3. What we already know (evidence log)](rich-text-editor-bakeoff/3-what-we-already-know.md)
- [4. The candidates](rich-text-editor-bakeoff/4-the-candidates.md)
- [5. The shared gauntlet (build once, run against everything)](rich-text-editor-bakeoff/5-the-shared-gauntlet.md)
- [6. Step 0 — corpus census (run FIRST; ~1 day; re-prices everything)](rich-text-editor-bakeoff/6-step-0-corpus-census.md)
- [7. Baselines (run SECOND; ~2–3 days)](rich-text-editor-bakeoff/7-baselines.md)
- [8. The probes](rich-text-editor-bakeoff/8-the-probes.md)
- [9. Sequencing and elimination](rich-text-editor-bakeoff/9-sequencing-and-elimination.md)
- [10. Practical pointers for the executing agent](rich-text-editor-bakeoff/10-practical-pointers.md)
- [11. Evidence log / verdicts](rich-text-editor-bakeoff/11-evidence-log-verdicts.md)
- [12. Decision and bounded next work](rich-text-editor-bakeoff/12-decision-and-next-work.md)
