# Speeding up the agent interaction loop (observe → decide → act)

Research note, 2026-09-11. Primary sources only; every number carries its URL. Status tags:
**[shipped]** = in a production product/API, **[research]** = paper result, **[demo]** = vendor
blog/benchmark without independent replication. App-specific driver mechanics (how to drive
FUTO Notes' shells) are covered separately in `docs/research/fast-agent-app-driving.md`; this
note is about the loop itself and cross-references that file where a mechanism lands there.

- [TL;DR](agent-interaction-loop-speed/tldr.md) — the six findings in one list.
- [1. Cost model of one iteration](agent-interaction-loop-speed/iteration-cost-model.md) — where one
  observe → decide → act step spends time and tokens, from published fragments.
- [2. Removing iterations](agent-interaction-loop-speed/removing-iterations.md) — code mode and
  batching, plan-then-execute and parallel dispatch, learned skills, hierarchical controllers.
- [3. Shrinking the observation](agent-interaction-loop-speed/shrinking-the-observation.md) —
  SWE-agent's ACI ablations, a11y snapshots vs screenshots, diff-only and pruned observations.
- [4. Pushing instead of polling](agent-interaction-loop-speed/push-instead-of-polling.md) — MCP
  subscriptions and progress, CDP events, hooks, the post-action state in the result.
- [5. Making actions land](agent-interaction-loop-speed/actions-that-land-first-time.md) —
  guardrails, strict schemas, examples, consolidated actions, errors written for the model.
- [6. Model-side levers](agent-interaction-loop-speed/model-side-levers.md) — prompt caching,
  preserved reasoning, parallel calls, effort, faster serving, speculative actions.
- [7. Measured results, consolidated](agent-interaction-loop-speed/measured-results.md) — every
  sourced before → after number in one table.
- [Mechanisms that generalize](agent-interaction-loop-speed/mechanisms-that-generalize.md) —
  fourteen mechanisms, each with its evidence strength.
- [Open questions](agent-interaction-loop-speed/open-questions.md) — what no primary source settles.
- [Sources](agent-interaction-loop-speed/sources.md) — papers, Anthropic docs and posts, other
  first-party pages.
