## Q3. Batching and scripting many actions per agent turn

### Action arrays (the model emits N tool calls in one response)

OBSERVED — Anthropic computer-use tool: "Claude can return multiple actions in one response. Run
them sequentially and stop at the first failure", answering the rest with "Not executed: an earlier
computer action in this turn failed." Prompt guidance: "End each group of actions with a screenshot
so you can verify the result before continuing", or attach the screenshot to the last result "to save
a round trip". [prod]

OBSERVED — browser-use: `max_actions_per_step` default 5, "e.g. for form filling the agent can output
4 fields at once"; `flash_mode` "skips evaluation, next goal and thinking and only uses memory";
`use_vision="auto"` "includes screenshot tool but only uses vision when requested". [oss]

OBSERVED — chrome-devtools-mcp `fill_form`: "ALWAYS prefer this tool over multiple individual 'fill'
or 'click' calls when interacting with forms." Playwright MCP has `browser_fill_form` ("Fill
multiple form fields") and `browser_run_code_unsafe` ("Run a Playwright code snippet"). [oss]

OBSERVED — UFO² [paper+oss]: "speculative multi-action planning, reducing per-step LLM overhead";
README table: "**Speculative Multi-Action** | Batch predictions → **51% fewer LLM calls**".

### Step files / DSLs (the harness runs a script; the model wrote or chose it)

OBSERVED — agent-device `batch`: "Use `batch` to run multiple commands in a single daemon request.
This is useful for agent workflows that already know the next sequence of actions and want to reduce
orchestration overhead." Steps are `{ "command", "input", "runtime" }`; "nested `batch` and `replay`
steps are rejected"; "`--on-error stop` is the supported behavior"; failure returns `details.step`
and `partialResults` so the agent can "Replan from the failing step". Guidance: "Keep batches
moderate (about 5-20 steps)", "After mutating steps … add a sync guard (`wait`, `is exists`) before
critical reads", "Treat prior refs/snapshots as stale after UI changes." [oss]

OBSERVED — agent-device `.ad` replay (ADR 0012): scripts are "one action per line" with a
platform/device header; replay detects four divergence classes ("selector-miss", "identity-mismatch",
"identity-unverifiable", "action-failure") and returns "one `repairHint` enum" — `record-and-heal`,
`state-repair`, `manual/caution` — and resumes with `--from N --plan-digest <sha>`. ADR 0020 composes
fragments: "If thirty flows share a login journey, the reusable unit should be one fragment, not
thirty closed scripts", with a measured economics line: "re-recording as cheaper than agent repair
for label drift ($1.21 versus a $2.34 repair median)". [oss]

OBSERVED — Maestro flows are YAML ("Tests are defined in simple YAML files, allowing user journeys,
referred to as Flows, to be readable as English instructions") with automatic settle waits; Google's
Android Studio Journeys are XML of natural-language steps ("Tap 'Dismiss'", "Type 'celery' in the
search bar…") executed by Gemini from screenshots — "The screenshots that were sent to Gemini are
shown for visual aid at each action" — and explicitly lack "Memory", "Counting", "Conditional
statements". [prod, Studio Labs]

### Code mode (the model writes a program that calls the tools)

OBSERVED — Anthropic programmatic tool calling [prod]: "Claude write[s] code that calls your tools
programmatically within a code execution container, rather than requiring round trips through the
model for each tool invocation"; "Tool results from programmatic calls are not added to Claude's
context - only the final code output is"; "The model is not re-sampled between the tool calls inside
one code execution". Numbers: "On a 75-tool project-management agent benchmark, enabling programmatic
tool calling reduced billed input tokens by roughly 38% with no change in task accuracy"; on τ²-bench
"programmatic tool calling left scores unchanged and cost roughly 8% more. Sequential single-call
workflows do not benefit"; production traffic with 10–49 tools sees "typical token savings of 20% to
40%"; the Nov-2025 engineering post reports "43,588 to 27,297 tokens, a 37% reduction on complex
research tasks" and accuracy "25.6% to 28.5%" (internal retrieval) / "46.5% to 51.2%" (GIA). Hard
limit that matters here: "The computer use and browser use toolsets (`computer_toolset_20260801` and
`browser_toolset_20260801`), whose `allowed_callers` field accepts only `"direct"`" — Anthropic does
*not* let the model script its own UI driving. Also `allowed_callers` "is not a hard API-level block
… Do not rely on `allowed_callers` as a security boundary"; pending tool results time out "after
about 4 minutes".

OBSERVED — Cloudflare Code Mode [prod, oss]: thesis "LLMs have seen a lot of code. They have not
seen a lot of 'tool calls'"; MCP schemas become a TypeScript API with doc comments; code runs in a
Dynamic Worker isolate where "The global `fetch()` and `connect()` functions throw errors" and tools
are reached through bindings ("already-authorized client interface"). The Cloudflare API MCP server
exposes only `search()` and `execute()`: "An equivalent MCP server without Code Mode would consume
1.17 million tokens" versus "roughly 1,000 tokens of context". Isolates: "An isolate takes a few
milliseconds to start and uses a few megabytes of memory. That's around 100x faster and 10x-100x
more memory efficient than a typical container." Agents SDK reference: default execution timeout
60,000 ms (Workers), response truncation budget "6,000 estimated tokens". No accuracy or latency
benchmarks published.

OBSERVED — CodeAct [paper]: executable Python as the action space gives "up to 20% higher success
rate" than JSON/text actions. Voyager [paper]: "an ever-growing skill library of executable code for
storing and retrieving complex behaviors", "3.3x more unique items", tech-tree milestones "up to
15.3x faster".

INFERRED (high): the ordering by leverage is code-mode > step file > action array > one call per
turn, and the ordering by *availability for UI driving today* is exactly reversed — Anthropic
forbids PTC on computer use, Cloudflare's isolates have no device access, so a UI harness must
provide its own script runner (agent-device `batch`, Playwright `run_code_unsafe`, a REPL fed a
block). INFERRED (medium): the τ²-bench result generalises — batching pays only when the agent can
predict step N+1 without seeing step N's screen, which is precisely what a typed semantic manifest
buys and an a11y tree does not.
