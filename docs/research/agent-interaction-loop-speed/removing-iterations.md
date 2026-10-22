## 2. Removing iterations

### 2.1 Code-mode / batching: the model writes a program that calls many tools

| Mechanism | Measured effect | Source | Status |
|---|---|---|---|
| CodeAct (LLM emits executable Python as the action) | M3ToolEval, gpt-4-1106-preview: 74.4% success with CodeAct vs 53.7% with text actions; 5.5 avg turns vs 7.7 (~29% fewer); "up to 20% higher success rate", "up to 30% fewer actions" | https://arxiv.org/html/2402.01030 | research |
| Anthropic Programmatic Tool Calling (Claude writes Python in a code-execution container that calls `allowed_callers` tools; only the script's final output enters context) | Internal knowledge retrieval 25.6% → 28.5%; GIA 46.5% → 51.2%; average tokens 43,588 → 27,297 (37% less). Docs add: BrowseComp/DeepSearchQA +11% average with 24% fewer input tokens; 75-tool PM agent benchmark 38% fewer billed input tokens, no accuracy change; τ²-bench "left scores unchanged and cost roughly 8% more. Sequential single-call workflows do not benefit"; production traffic with 10–49 tools sees "typical token savings of 20% to 40%" | https://www.anthropic.com/engineering/advanced-tool-use ; https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/programmatic-tool-calling | shipped |
| Cloudflare Code Mode (MCP schemas → TypeScript API; agent emits one TS program run in a V8 isolate) | Argument only: "the output of each tool call must feed into the LLM's neural network, just to be copied over to the inputs of the next call, wasting time, energy, and tokens". No numbers | https://blog.cloudflare.com/code-mode/ | shipped, unmeasured |
| smolagents CodeAgent | Cites CodeAct and two other papers for "code actions"; no first-party numbers | https://huggingface.co/docs/smolagents/conceptual_guides/intro_agents | shipped OSS |
| Replit Agent 3 self-testing (agent writes Playwright/JS in a persistent REPL rather than per-action tool calls) | Autonomy "from 20 minutes to over 200 minutes"; median $0.20 per test session; secondary sources quote "3x faster and 10x more cost-effective than Computer Use models" — **UNVERIFIED**: that phrase was not on the fetched page; settle by reading https://blog.replit.com/introducing-agent-3-our-most-autonomous-agent-yet | https://replit.com/blog/automated-self-testing | shipped |
| Playwright MCP `browser_run_code_unsafe` / Chrome DevTools MCP `evaluate_script` | Scripted multi-step in one tool call; no published measurements | https://github.com/microsoft/playwright-mcp ; https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/tool-reference.md | shipped |
| Anthropic computer-use batching (model returns several `tool_use` blocks in one turn, executed in order, stop at first failure) | "saves a round trip" per the docs; no numbers | computer use tool docs (link above) | shipped |
| Browser Use `max_actions_per_step` (default 5) | Batches actions "before awaiting page changes"; no isolated measurement | https://docs.browser-use.com/customize/agent/all-parameters | shipped OSS |

The τ²-bench result is the important negative: code mode has a fixed overhead (spinning up
execution, writing code) and only pays when a turn would otherwise need ≥3 dependent calls or
large intermediate data. Anthropic's own guidance: use it for "multi-step workflows with three
or more dependent tool calls" and "processing large datasets where you only need aggregates".

### 2.2 Plan-then-execute and parallel dispatch

| Mechanism | Measured effect | Source | Status |
|---|---|---|---|
| ReWOO (plan all tool calls upfront, decoupled from observations) | "5x token efficiency and 4% accuracy improvement on HotpotQA" | https://arxiv.org/abs/2305.18323 | research |
| LLMCompiler (planner emits a DAG of calls; executor runs them in parallel) | vs ReAct: latency speedup "up to 3.7x", cost "up to 6.7x", accuracy "up to ~9%" | https://arxiv.org/abs/2312.04511 | research |
| Anthropic parallel tool calls + subagent fan-out | "cut research time by up to 90% for complex queries"; multi-agent (Opus 4 lead, Sonnet 4 subagents) beat single Opus 4 by 90.2% on the internal research eval, at ~15x chat token cost | https://www.anthropic.com/engineering/multi-agent-research-system | shipped |
| Claude Code subagents | Own context window, "returns only the summary" ("often 1,000-2,000 tokens" per the context-engineering post); background subagents run concurrently | https://code.claude.com/docs/en/sub-agents ; https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents | shipped |
| Cognition counter-position | "Share context, and share full agent traces"; "Actions carry implicit decisions, and conflicting decisions carry bad results"; recommends a single-threaded linear agent plus a dedicated compression model for long tasks | https://cognition.com/blog/dont-build-multi-agents | shipped (Devin), argument not measurement |
| Claude Code plan mode | Docs caution "Plan mode is useful, but also adds overhead… If you could describe the diff in one sentence, skip the plan" | https://code.claude.com/docs/en/best-practices | shipped |

Read together: parallelism removes wall clock, not tokens (Anthropic's 15x). Cognition's
objection is about correctness when parallel workers make conflicting implicit decisions, which
argues for parallelizing *reads* (search, verification) and serializing *writes*.

### 2.3 Macros, skills, and workflows learned from prior runs

| Mechanism | Measured effect | Source | Status |
|---|---|---|---|
| Voyager skill library (executable code skills indexed by description embedding, top-5 retrieval) | 3.3x more unique items, 2.3x longer distances, key tech-tree milestones "up to 15.3x faster"; ablation: "Voyager w/o skill library exhibits a tendency to plateau in the later stages" | https://arxiv.org/html/2305.16291 | research |
| Agent Workflow Memory (induce reusable workflows from past trajectories) | Mind2Web +24.6% relative success; WebArena +51.1% relative "while reducing the number of steps taken to solve"; online AWM beats baselines by 8.9–14.0 absolute points as train/test distribution gap widens | https://arxiv.org/abs/2409.07429 | research |
| SkillWeaver (explore a site, synthesize and test API-like skills) | WebArena +31.8% relative; live websites +39.8% relative; strong-agent skills lift weaker agents "up to 54.3% on WebArena" | https://arxiv.org/abs/2504.07079 | research |
| Claude Code / Agent Skills (SKILL.md, progressive disclosure: name+description at startup, body on invoke, bundled scripts run without entering context) | Design, not measurement: "the amount of context that can be bundled into a skill is effectively unbounded"; listing text truncated at 1,536 characters per skill; re-attached after compaction at 5,000 tokens each within a 25,000-token budget | https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills ; https://code.claude.com/docs/en/skills | shipped |
| Anthropic tool-description iteration | Rewriting a tool description after observing failures "resulted in a 40% decrease in task completion time for future agents" | multi-agent research post (above) | shipped |

Skills are macros with a lookup cost of one description line; the research results show
learned macros both raise success and shorten trajectories, and the transfer result
(SkillWeaver) says a strong agent can pre-compute them for a cheap one.

### 2.4 Hierarchical controllers

| Mechanism | Measured effect | Source | Status |
|---|---|---|---|
| Agent S2 (generalist planner + specialist grounding, "Proactive Hierarchical Planning", Mixture-of-Grounding) | OSWorld relative improvement over Claude Computer Use / UI-TARS: 18.9% at 15 steps, 32.7% at 50 steps; WindowsAgentArena +52.8%, AndroidWorld +16.52% relative | https://arxiv.org/abs/2504.00906 | research |
| AgentOccam planning tree (`branch` / `prune` actions; earlier plans' observations dropped from the current window) | Part of 16.5% → 43.1% on WebArena; planning tree credited with the final 6–8 points | https://arxiv.org/html/2410.13825 | research |
| Anthropic orchestrator–worker | see 2.2 | | shipped |

Hierarchy's measured benefit grows with step budget (Agent S2: 18.9% → 32.7% from 15 to 50
steps), which is consistent with it paying off by *recovering* from bad branches rather than by
making each step cheaper.
