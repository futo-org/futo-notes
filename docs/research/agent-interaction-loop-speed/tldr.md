## TL;DR

1. The loop's dominant cost is the model call, and the model call's cost is dominated by
   output tokens and by observation size; wall clock is roughly per-step fixed overhead
   (harness + tool) plus tokens in plus tokens out. Nobody publishes a clean per-phase breakdown;
   the best fragments are Browser Use (~0.8 s per screenshot, output tokens ~215x slower than
   input per token), Cognition (up to 2 s/step of harness overhead removed), SWE-agent (median 12
   steps, $1.21 per solved instance).
2. The biggest wins remove iterations rather than shrink them: code-mode / programmatic tool
   calling (Anthropic: 37% fewer tokens, N round trips → 1; CodeAct: 29% fewer turns), parallel
   tool calls (Anthropic research system: up to 90% less wall clock), learned skills/workflows
   (AWM: +51% success and fewer steps on WebArena).
3. Observation design is a first-order lever: SWE-agent's 100-line file window beats the full
   file by 5.3 pp; summarized search beats iterative by 6 pp; AgentOccam's observation and
   action pruning took WebArena from 16.5% to 43.1%. Text/a11y snapshots with refs beat
   screenshots for cost and determinism; screenshots win only where the a11y tree lies.
4. Push beats poll: MCP `resources/subscribe`, CDP lifecycle events, and Claude Code hooks
   turn "wait, screenshot, check" into a wake-on-change, deleting whole iterations.
5. First-try landing is mostly interface design: linting guardrails (+3 pp), strict schemas
   (grammar-constrained, no validation retries), returning the post-action state with the
   result (saves a round trip), and error messages written for the model.
6. Model-side: prompt caching (0.1x read price), preserved reasoning across tool calls
   (OpenAI: 40-80% better cache hits), effort/`flash_mode` on routine steps, fast draft models
   for speculative decoding; speculative *actions* are still research (≤20% latency win).

---
