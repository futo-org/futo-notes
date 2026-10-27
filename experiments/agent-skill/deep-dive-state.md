# Deep dive: app state, and what each turn passes to an agent

Date 2026-09-24, worktree `elated-kowalevski-3173cb` at `9bc08048`. Read-only. This builds on
`pipeline-audit.md` (F1–F8, C1–C7) and does not repeat it. Where a number is new, it was measured
here:

- **Live:** read-only calls to this worktree's desktop dev app (`FUTO_AGENT_JEV=off target/debug/futo-agent state|notes|doc|actions|elements|step`).
- **Jev:** 317 recorded turns (`tool-eval/runs/{jev-desktop-final,jev-ios-final,jev-workflows-merged-5}` and `.agent/drive/2026-09-24*`). Each turn was rebuilt with the current `buildTurn`, and then with a lean prototype.
- **Claude:** 87 action→read pairs from the 30 `runs-diagnose` transcripts.
- **Receipts:** 9,049 `do` receipts from `.agent/trace.jsonl`.

The scripts are in the session scratchpad: `turns.mjs`, `measure-now.mjs`, `lean.mjs`,
`measure-lean.mjs` and `pairs.mjs`. Tokens are counted at 3.84 chars/token. That rate comes from
comparing the rebuilt requests with the `inputTokens` recorded for the same runs.

Overlaps with the two sibling agents, one line each:

- **(a) traces/logs:** this document defines *what* gets stored (AppState by id) and not the trace
  file format.
- **(b) overlays/focus:** this document reserves the `overlay`/`focus` fields and their diff
  grammar, and (b) owns how they are derived.

---

- [0. Decisions](deep-dive-state/decisions.md): one AppState, one diff model, text results for Claude, a lean request for Jev
- [1. Inventory of state today](deep-dive-state/inventory.md): every state field today with its size and consumers, payload sizes, defects N1–N6
- [2. The full state: `AppState` v1](deep-dive-state/app-state-schema.md): the AppState v1 schema, its content-hash id and where it is stored
- [3. The lean per-turn payloads](deep-dive-state/turn-payloads.md): Claude's text result (grammar, rules, worked examples) and Jev's lean step state
- [4. One state and diff model across desktop, iOS and Android](deep-dive-state/cross-platform-diff.md): the CLI diffs AppState before and after a verb, the same on all three platforms
- [5. What the transcripts show: reads after actions](deep-dive-state/reads-after-actions.md): the reads agents made after actions, and which ones the lean result makes unnecessary
- [6. To delete](deep-dive-state/deletions.md): what to delete, per layer
- [7. Implementation plan: ordered, test-first](deep-dive-state/implementation-plan.md): the six steps, in order, each red first
