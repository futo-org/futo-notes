# Deep dive: traces and logs in the agent-driving system

Date 2026-09-24, worktree `elated-kowalevski-3173cb` at `9bc08048`. Read-only: no tracked file
was edited, no verb was run. The live numbers come from this worktree's desktop dev app (pid
26881, bridge :9269), read with `FUTO_AGENT_JEV=off target/debug/futo-agent state|events|step`
and one read-only `execute_js` peek at the console buffer. The recorded evidence comes from
`.agent/trace.jsonl`, `.agent/drive/*.json` (28 files), `.tauri-data/journal/`,
`experiments/agent-skill/runs-diagnose/` (30 runs) and `tool-eval/runs/` (110 sweeps). The
scripts are in the session scratchpad (`trace-stats.mjs`, `peek.mjs`).

The requirement: a person or an agent can look at the full state and logs of a run afterwards,
and recording adds nothing to a driving turn.

Sibling work: (a) the per-turn payload (`ActionResult`, one `AppState`) supplies the state this
design stores. (b) Overlay and focus visibility adds fields to that state, and this design
records them with no extra work.

---

- [0. The audit's trace findings, checked](deep-dive-traces/audit-findings-checked.md): the audit's trace findings checked, and further findings
- [1. Current map](deep-dive-traces/current-map.md): every record today: producer, location, lifetime, ids, growth, what survives
- [2. Investigation stories, checked against today's records](deep-dive-traces/investigation-stories.md): seven investigation stories, checked against the records of 2026-09-24
- [3. Proposed record model](deep-dive-traces/record-model.md): the proposed per-run JSONL record: identity, record types, writing, log correlation, `just agent trace`
- [4. Cost](deep-dive-traces/cost.md): the measured cost of recording, and its budget
- [5. What to delete](deep-dive-traces/deletions.md): what to delete
- [6. Implementation plan (test first, in order)](deep-dive-traces/implementation-plan.md): the six steps, test first, and the standing risks
