# Agent pipeline audit: what the app tells agents, and how it gets to them

Date 2026-09-24, worktree `elated-kowalevski-3173cb` at `9bc08048`. Read-only audit: nothing was
edited and no verb was run. Live numbers come from this worktree's desktop dev app (pid 26881,
bridge :9269), measured with read-only queries and `FUTO_AGENT_JEV=off`. Recorded evidence comes
from 30 diagnose transcripts (`runs-diagnose/*/*/transcript.jsonl`, 226 agent CLI calls), 28 drive
traces (`.agent/drive/*.json`), `.agent/trace.jsonl` (25,583 lines, 2026-09-21 to 09-24), and the
Jev sweeps in `tool-eval/runs/`. The scripts that produced the numbers are in the session
scratchpad (`analyze.mjs`, `jevsize.mjs`, `measure.mjs`). The coordinator's `reads-after-do.mjs`
covers the same ground and gets the same counts.

---

- [1. Current map](pipeline-audit/current-map.md): the pipeline today, with what each hop carries and costs
- [2. Findings, ranked by impact](pipeline-audit/findings.md): F1–F8 ranked by impact, and the user's hypothesis tested
- [3. Proposed map](pipeline-audit/proposed-map.md): one ActionResult for every platform, and the changes C1–C7
- [4. Implementation plan, in order](pipeline-audit/implementation-plan.md): the seven steps, in order
