## 5. Making actions land the first time

| Mechanism | Evidence | Source | Status |
|---|---|---|---|
| Guardrails at the edit boundary (lint on edit, reject and explain) | SWE-agent: 18.0% with linting vs 15.0% without (Table 3) | https://arxiv.org/html/2405.15793 | research |
| Strict, typed schemas (grammar-constrained sampling) | `strict: true` "guarantees Claude's tool inputs match your JSON Schema"; "No need to validate and retry tool calls" | https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/strict-tool-use | shipped |
| Tool-use examples in the definition | complex parameter handling 72% → 90% in internal testing; each example costs ~20–50 tokens (simple) to ~100–200 (nested) | https://www.anthropic.com/engineering/advanced-tool-use ; https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/define-tools | shipped |
| Consolidated, high-level actions | "Instead of implementing a `list_users`, `list_events`, and `create_event` tools, consider implementing a `schedule_event` tool which finds availability and schedules an event"; "Consolidate related operations into fewer tools" | https://www.anthropic.com/engineering/writing-tools-for-agents ; define-tools docs | shipped guidance |
| Return the next state with the result | Playwright MCP snapshots after state-changing tools; Anthropic computer-use screenshot attached to the last batch result "saves a round trip"; SWE-agent's editor shows the post-edit window | sources above | shipped |
| Error messages written for the model | "errors should clearly communicate specific and actionable improvements"; MCP distinguishes protocol errors from `isError: true` tool results the model can read; Anthropic fine-grained streaming docs prescribe returning `{"INVALID_JSON": "..."}` with `is_error` so the model can repair | writing-tools post; MCP tools spec; https://platform.claude.com/docs/en/docs/agents-and-tools/tool-use/fine-grained-tool-streaming | shipped |
| Batch semantics: stop at first failure, mark the rest "Not executed" | Anthropic computer-use batching rule prevents cascading on a stale precondition | computer use tool docs | shipped |
| Idempotency and behavior hints | MCP tool `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) let hosts retry/parallelize safely; spec says clients "MUST consider tool annotations to be untrusted unless they come from trusted servers" | https://modelcontextprotocol.io/specification/2025-06-18/server/tools | shipped spec |
| Verification the model can read | Claude Code best practices: "Give Claude a check it can run: tests, a build, a screenshot to compare"; Stop hook as "a deterministic gate"; "Have Claude show evidence rather than asserting success" | https://code.claude.com/docs/en/best-practices | shipped guidance |
| Self-testing with real execution instead of inspection | Replit's "Potemkin interface" failure mode: "buttons render correctly… But further interactions reveal that nothing is hooked up"; fixed by REPL + browser verification | https://replit.com/blog/automated-self-testing | shipped |
| Ground truth every step | "it's crucial for the agents to gain 'ground truth' from the environment at each step" | https://www.anthropic.com/research/building-effective-agents | shipped guidance |

Pattern: every mechanism here converts a *retry iteration* into either a rejected action with
a repair hint (linting, schema, error text) or a single richer result (next state attached).
The measured effects are modest per knob (3 pp, 18 pp on parameter handling) but they compound
because each avoided retry is a whole §1 step.
