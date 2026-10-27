# Jev drives the app: one decision per state change

Date: 2026-09-21. A shoot-off between the `futo-puppet` tool as an LLM uses it (Claude reads
the tool docs, plans, batches verbs) and a controller built for Jev, TypeSafe's System One
model, which cannot generate text or plan: it answers typed questions over a state object. The
controller rebuilds its whole question set from the live state on every turn and lets Jev pick
exactly one next step. Design record of the tool itself: `agent-native-app-design.md`.

- [Shape](jev-agent-shootoff/step-controller-shape.md) — `futo-puppet step` and the Jev controller:
  the questions it asks each turn and how a run ends.
- [Results, and what this says](jev-agent-shootoff/tool-eval-results.md) — the 31 tool-eval tasks,
  Jev + `step` against Claude + `futo-puppet`, the misses, the conclusions.
- [Round two: Jev gets the hands](jev-agent-shootoff/round-two-drive-and-text-input.md) — `drive`
  and its account, text input, the 20-workflow results.
- [Round three: handoffs](jev-agent-shootoff/round-three-handoffs.md) — `drive --handoff`, its
  signals and resume, the mixed-arm results.
- [Round four: a clipboard](jev-agent-shootoff/round-four-clipboard.md) — `PlaceCaret`, `Copy` and
  `Paste` for `merge-lists`.
- [Round five: the loop's gains, merged](jev-agent-shootoff/round-five-optimisation-loop-merge.md) —
  text anchors, `notes`, `wrote` receipts, and the controller changes they needed.
- [Round six: the result, and Enter](jev-agent-shootoff/round-six-account-and-enter.md) — changed
  lines in the account, `no change` for caret moves, the `Enter` verb.
- [Ranked improvements](jev-agent-shootoff/ranked-improvements.md) — what to measure or fix next.
- [Round seven: on a phone](jev-agent-shootoff/round-seven-phone.md) — `observe` on iOS, phone
  resets, the 17-of-18 sweep, five controller and app fixes.
- [Running it](jev-agent-shootoff/running-it.md) — the commands for one drive and for a sweep,
  desktop and iOS.
