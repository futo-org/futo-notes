## 7. Measured results, consolidated

Only numbers with an exact source. "Rel." = relative improvement as reported.

| Technique | Metric | Before → After | Source |
|---|---|---|---|
| Code actions (CodeAct) | turns / success, M3ToolEval GPT-4 | 7.7 → 5.5 turns; 53.7% → 74.4% | https://arxiv.org/html/2402.01030 |
| Programmatic tool calling | tokens / accuracy | 43,588 → 27,297 tokens; GIA 46.5% → 51.2%; knowledge retrieval 25.6% → 28.5% | https://www.anthropic.com/engineering/advanced-tool-use |
| Programmatic tool calling | input tokens, 75-tool benchmark | −38%, accuracy unchanged | programmatic-tool-calling docs |
| Programmatic tool calling (negative) | τ²-bench cost | +8% cost, score unchanged | same |
| Programmatic tool calling on search | BrowseComp + DeepSearchQA | +11% average, −24% input tokens | same |
| Tool Search Tool | context / tool-selection accuracy | ~77K → ~8.7K tokens; Opus 4 49% → 74%; Opus 4.5 79.5% → 88.1% | advanced-tool-use post |
| Tool-use examples | complex parameter accuracy | 72% → 90% | same |
| Parallel tools + subagents | research wall clock | "up to 90%" less | multi-agent research post |
| Tool description rewrite | task completion time | −40% | same |
| Context editing (+ memory) | agentic search eval; 100-turn token use | +29% (editing), +39% (with memory); −84% tokens | https://claude.com/blog/context-management |
| LLMCompiler | latency / cost vs ReAct | up to 3.7x / 6.7x; accuracy up to ~9% | https://arxiv.org/abs/2312.04511 |
| ReWOO | token efficiency, HotpotQA | 5x; +4% accuracy | https://arxiv.org/abs/2305.18323 |
| SWE-agent ACI knobs | SWE-bench Lite resolved | linting 15.0 → 18.0; search summarized 12.0 → 18.0; window 100 lines vs full file 12.7 → 18.0; last-5 history 15.0 → 18.0 | https://arxiv.org/html/2405.15793 |
| AgentOccam obs/action alignment | WebArena success | 16.5% → 43.1% | https://arxiv.org/html/2410.13825 |
| OSWorld observation type | success, GPT-4V | screenshot 5.26%, a11y 12.24%, both 12.17%, SoM 11.77% | https://arxiv.org/html/2404.07972 |
| Set-of-Mark | RefCOCOg REC | 25.7 → 86.4 | https://arxiv.org/html/2310.11441 |
| Agent Workflow Memory | success / steps | Mind2Web +24.6% rel.; WebArena +51.1% rel. with fewer steps | https://arxiv.org/abs/2409.07429 |
| SkillWeaver | success | WebArena +31.8% rel.; live sites +39.8% rel.; transfer up to +54.3% | https://arxiv.org/abs/2504.07079 |
| Voyager skill library | exploration | 3.3x items, 2.3x distance, 15.3x faster milestones | https://arxiv.org/html/2305.16291 |
| Agent S2 hierarchy | OSWorld rel. improvement | +18.9% (15 steps), +32.7% (50 steps) | https://arxiv.org/abs/2504.00906 |
| Preserved reasoning (Responses API) | cache utilization / TAUBench | +40–80% / +5% | https://developers.openai.com/blog/responses-api |
| Harness rewrite (Cognition) | per-step overhead | up to −2 s | https://cognition.com/blog/swe-1-5 |
| Fast serving (Cognition) | tok/s | 950; 6x Haiku 4.5, 13x Sonnet 4.5; 20 s → <5 s on a manifest edit | same |
| Browser Use loop tuning | per step / per task | ~3 s per step; 68 s per task vs 225–330 s for competitors (vendor-run) | https://browser-use.com/posts/speed-matters |
| Replit self-testing | autonomy / cost | 20 min → 200+ min; $0.20 median per test session | https://replit.com/blog/automated-self-testing |
| Speculative actions | latency | up to −20% at 55% prediction accuracy | https://arxiv.org/abs/2510.04371 |

Numbers deliberately excluded: OpenAI CUA benchmark scores (direct fetch blocked), Replit's
"3x faster / 10x cheaper than Computer Use" (not on the fetched page), any Sourcegraph Amp or
Devin latency figure (no first-party measurement found).
