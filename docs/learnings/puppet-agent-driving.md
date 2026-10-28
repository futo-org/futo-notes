# Driving the apps with agents: what building `just puppet` taught us

Between 2026-09-11 and 2026-10-07 we built `just puppet`, which lets an agent drive and read the
three debug apps, and measured it with several hundred agent sessions. This file records what we
learned, and the evidence for each claim.

**Reading this file**

- **Names.** These changed along the way: the agent-native CLI, then `futo-agent` / `just agent`,
  the `app-control` skill, and finally `puppet`. The small-model drivers were Jev and Laya. This
  file uses today's names throughout.
- **Harness.** It is in `experiments/agent-skill/`. Its run records stay local; a label such as
  `heldout-s55m-v12-ios` names one of those runs.
- **Defaults.** Unless a line says otherwise, each figure is one desktop run, with Claude Sonnet
  5.5 at medium effort. The transcripts confirm `claude-sonnet-5-5` for every Sonnet run from
  10-01.
- **Noise.** Two identical runs differed by 0.7 calls and 60k tokens a goal, so read small
  differences as noise.
- **Seeded bugs** are named by id and area only, so this file cannot hand a benchmarked agent the
  answer.
- **Related reading.** `docs/research/` has the outside research, the design walk-through and the
  Jev shoot-off; `docs/agents/jev-handoff-draft.md` covers Jev hand-off.

- [The short version, and the timeline](puppet-agent-driving/short-version-and-timeline.md) — the
  seven lessons, and what happened when from 09-11 to 10-07.
- [1. Driving from outside the app](puppet-agent-driving/driving-from-outside-the-app.md) — why a
  listener inside each app beat `axe`, the MCP bridge and accessibility taps.
- [2. The verbs](puppet-agent-driving/verbs.md) — every handler a verb, one user action per verb,
  only what a person could reach, refusals that print the fix, editor positions, confirmations,
  names.
- [3. What the agent sees](puppet-agent-driving/what-the-agent-sees.md) — misleading receipts,
  measured waits, whole-app receipts, filtering and the hook, outlines, search, context size, visual
  bugs, the trace record.
- [4. Input, and the tool's own speed](puppet-agent-driving/input-and-tool-speed.md) — real desktop
  input into one web view, hidden windows, phone screen readers, error messages, latency, what
  ships.
- [5. Getting agents to use it](puppet-agent-driving/getting-agents-to-use-it.md) — docs nobody
  read, the instruction that owns the moment, pre-launched apps, suggestions vs gates, asking for
  the reproduction, the instruction arms.
- [6. Benchmarks](puppet-agent-driving/benchmarks.md) — the sets, real sessions, saturation,
  checking the checker, held-out and editor results, models, what the runs found, where the time
  goes.
- [7. Small-model drivers](puppet-agent-driving/small-model-drivers.md) — Granite 8B, Jev and Laya.
- [8. Diagnosis](puppet-agent-driving/diagnosis.md) — the two harnesses, reproduction rates, narrow
  verification, grading lessons.
- [9. Still open](puppet-agent-driving/still-open.md) — what is still unbuilt or unmeasured.
