## Mechanisms that generalize

Evidence strength: **strong** = replicated or multiple independent primary sources with numbers;
**medium** = one primary source with numbers; **weak** = shipped/argued, no numbers.

1. **Emit code, not one call per turn, when a turn needs ≥3 dependent calls or large
   intermediate data** — strong (CodeAct, Anthropic PTC, LLMCompiler; τ²-bench negative
   bounds it).
2. **Parallelize reads; serialize writes** — medium (Anthropic 90% wall clock; Cognition's
   conflict argument; LLMCompiler 3.7x).
3. **Bound the observation to a window and summarize instead of paging** — strong (SWE-agent
   window and search ablations; OSWorld 6,000-token point; AgentOccam).
4. **Prefer text/a11y snapshots with stable refs; screenshot on demand; set-of-marks when a
   pixel is unavoidable** — strong (OSWorld Table 5, SoM, Playwright MCP, Browser Use 0.8 s).
5. **Collapse or clear old observations; keep decisions** — strong (SWE-agent last-5; Anthropic
   context editing −84% tokens, +29%; Claude Code compaction).
6. **Attach the post-action state to the action result** — medium (Anthropic "saves a round
   trip", Playwright MCP snapshots; no A/B number).
7. **Wake on change instead of polling** — weak on numbers, strong on availability (MCP
   subscribe/progress, CDP lifecycle events, `wait_for`, hooks).
8. **Guardrail at the boundary and write errors for the model** — medium (SWE-agent +3 pp;
   strict schemas remove validation retries; tool examples +18 pp on parameters).
9. **Learn macros from successful runs and retrieve by description** — strong in research
   (Voyager, AWM, SkillWeaver), shipped as Skills without a published measurement.
10. **Defer tool schemas; load on demand** — medium (Tool Search 85% fewer tokens, +25 pp
    selection accuracy for Opus 4).
11. **Cache the prefix and never mutate it mid-loop** (hold effort/budget/tool_choice
    constant, prune screenshots in batches, preserve reasoning items) — strong (pricing 0.1x;
    OpenAI 40–80% cache utilization; Anthropic caching rules).
12. **Spend thinking unevenly: low effort / flash mode on routine steps, high on decisions** —
    medium (effort docs describe fewer, terser tool calls; Browser Use flash mode; no
    published A/B).
13. **Make the harness fast once the model is** — medium (Cognition's up-to-2 s/step; only one
    source, but mechanically obvious).
14. **Speculate the next action with a cheap model** — weak/early (one paper, ≤20%).
