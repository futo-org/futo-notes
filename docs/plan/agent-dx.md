# Agent developer experience — what an agent needs to verify its own work

**Status:** P1 built on this branch (MR !291), 2026-09-08: `just wt`, `just orient`,
`just ci-wait`/`mr-status`, `just detached`, the weekly papercut sweep, and the fresh-worktree
preflights. Of the three P1.2 hooks, `SessionStart`/`SubagentStart` shipped; the `PreToolUse`
Bash-deny hook (guard-bash.mjs) was removed 2026-09-23 as too broad (it denied unrelated commands
repo-wide) — see AGENTS.md §5. P2 and P3 are still proposals. Branch `chore/agent-dx`, worktree
`../futo-notes-agent-dx`.
**Audience:** Justin first, then whichever session picks up an item. Every P1 item is one small MR.
**Evidence base:** 180 Claude Code sessions on both machines (113 on jfedora, 2026-08-05 → 09-05;
67 on the MacBook), the committed `.papercuts.jsonl` (199 cuts, 64 resolves), a survey of every
worktree on both machines, the GitLab pipelines API, a timed cold `just check` in a fresh worktree,
and outside reading: OpenAI's and Martin Fowler's harness-engineering essays, Addy Osmani's agent
harness notes, Claude Code's hooks reference, callstack's `agent-device`, and Maestro MCP.

- [0. Verdict](agent-dx/0-verdict.md)
- [1. The evidence](agent-dx/1-the-evidence.md)
- [2. What I need, stage by stage](agent-dx/2-what-i-need-stage-by-stage.md)
- [3. Recommendations](agent-dx/3-recommendations.md)
- [4. Stop doing](agent-dx/4-stop-doing.md)
- [5. How we work better together](agent-dx/5-how-we-work-better-together.md)
- [6. What I checked and did not](agent-dx/6-what-i-checked-and-did-not.md)
- [7. Proposed first MR set](agent-dx/7-proposed-first-mr-set.md)
