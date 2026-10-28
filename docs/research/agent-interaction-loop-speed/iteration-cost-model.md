## 1. Anatomy and cost model of one iteration

One iteration is: serialize observation → model call (prefill + decode) → parse action →
harness dispatch → tool executes → environment settles → verification observation → repeat.
Wall clock is approximately

```
T_step ≈ T_prefill(context) + T_decode(output tokens) + T_harness + T_tool + T_settle
```

and the number of steps multiplies all of it. Published fragments of this model:

| Component | Evidence | Source | Status |
|---|---|---|---|
| Output tokens dominate model time | "Output tokens cost ~215x more time than input tokens per unit time" (10 output tokens 62.6 ms vs 1,000 input tokens 29.1 ms); most browser actions fit in "10-15 tokens" | Browser Use, "Speed Matters" https://browser-use.com/posts/speed-matters | demo |
| Screenshot cost per step | "each screenshot adds ~0.8 seconds to LLM inference latency"; ~3 s per step with their strongest model; 68 s average task | same | demo |
| Screenshot token cost | "roughly 1,000–1,800 input tokens each"; prune old screenshots in batches to keep the cache | Anthropic computer use tool docs https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/computer-use-tool | shipped |
| Harness overhead per step | Cognition "rewrote critical components including lint checking and command execution pipelines, which reduced overhead per step by up to 2s"; "previously negligible system delays emerged as dominant bottlenecks" once the model ran at 950 tok/s | Cognition SWE-1.5 https://cognition.com/blog/swe-1-5 | shipped (Windsurf) |
| Steps and cost per task | SWE-agent on SWE-bench: successful instances median $1.21 and median 12 steps; unsuccessful mean $2.52 and mean 21 steps | SWE-agent paper §results https://arxiv.org/html/2405.15793 | research |
| Steps and cost per task | OpenHands, SWE-bench Lite, Claude 3.5 Sonnet: 26.0% at $1.10 average per instance | OpenHands https://arxiv.org/html/2407.16741 | research |
| Tokens explain performance | "token usage by itself explains 80% of the variance" in BrowseComp; tool-call count and model choice explain most of the rest | Anthropic multi-agent research system https://www.anthropic.com/engineering/multi-agent-research-system | shipped |
| End-to-end task latency, browser agents | Browserbase Online-Mind2Web: Gemini 2.5 Computer Use "70%+ accuracy, ~225 sec latency"; Browser Use quotes competitors at 225 / 285 / 295 / 330 s (Gemini 2.5 CU, Sonnet 4.5, Sonnet 4, OpenAI CUA) | Google https://blog.google/technology/google-deepmind/gemini-computer-use-model/ ; Browser Use link above | demo |
| Observation size ceiling | "AXTree can still be larger than 100,000 tokens, with the raw HTML/DOM counting more than 1,000,000 tokens" | BrowserGym https://arxiv.org/html/2412.05467 | research |
| Observation size, desktop | OSWorld: "a context length of 6000 is needed to accommodate about 90% of cases for a single observation" (a11y tree) | OSWorld https://arxiv.org/html/2404.07972 | research |
| Self-test loop cost | Replit Agent 3 self-testing: "multi-hundred step testing at a median cost of $0.20 per session"; main-agent context "often reaches 80,000 to 100,000 tokens" | Replit https://replit.com/blog/automated-self-testing | shipped |

What is *not* published: a first-party per-phase wall-clock breakdown (prefill vs decode vs
tool vs harness) for Claude Code, Cursor, Devin, or OpenAI Codex. Claude Code's own docs
describe the loop as gather context → take action → verify results and describe compaction
behavior, but give no timing (https://code.claude.com/docs/en/how-claude-code-works). Cursor's
Composer post reports "generation speed four times faster than similar models" and that RL
rewards "maximize parallelism whenever possible", with no latency or turn-count data
(https://cursor.com/blog/composer). **UNVERIFIED gap**: a real breakdown would need harness
tracing (per-step timestamps for request start, first token, last token, tool start/end) on a
fixed task set; this is cheap to instrument locally and worth doing before optimizing.

Where the wall clock actually goes, from the fragments: (a) decode time of the action and any
thinking, which is why "flash"/low-effort modes and terse action formats pay off; (b) prefill
of a growing context, which caching largely neutralizes; (c) fixed per-step harness and tool
costs (lint, command spawn, settle waits) that become dominant once the model is fast
(Cognition's observation); (d) the step count itself, which multiplies everything and is the
lever with the largest published effects (§2, §3).
