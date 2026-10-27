## 3. Shrinking the observation

### 3.1 SWE-agent's ACI results (the key primary source)

Principles, verbatim (§2 of https://arxiv.org/html/2405.15793): "Actions should be simple and
easy to understand for agents"; "Actions should be compact and efficient. Important operations
should be consolidated into as few actions as possible"; "Environment feedback should be
informative but concise"; "Guardrails mitigate error propagation and hasten recovery".

Ablations (Table 3, SWE-bench Lite, % resolved):

| Knob | Setting | Resolved |
|---|---|---|
| Editor | edit with linting | 18.0 |
| | edit without linting | 15.0 |
| | no edit command (shell only) | 10.3 |
| Search | summarized results | 18.0 |
| | iterative (paged) results | 12.0 |
| | no search tools | 15.7 |
| File viewer window | 100 lines | 18.0 |
| | 30 lines | 14.3 |
| | full file | 12.7 |
| History shown | last 5 observations in full, older ones collapsed | 18.0 |
| | full history | 15.0 |
| | without demonstration | 16.3 |

Three findings generalize beyond code: (1) there is an *optimal* observation size, and both too
small (30 lines) and too large (whole file) hurt; (2) a summarized result beats paging through
the same data across turns by 6 pp, i.e. the summary removes iterations *and* raises success;
(3) collapsing old observations (keep the last 5) beats full history by 3 pp, so context
hygiene is a success lever, not only a cost lever.

### 3.2 Representation choice: a11y/text snapshots with refs vs screenshots vs semantic state

| Evidence | Source | Status |
|---|---|---|
| OSWorld Table 5 (GPT-4V): a11y tree only 12.24%, screenshot only 5.26%, screenshot + a11y 12.17%, set-of-marks 11.77%; human 72.36%. "longer text-based trajectory history context improves performance" for a11y but "the inclusion of additional trajectory history does not enhance performance under the pure screenshot setting" | https://arxiv.org/html/2404.07972 | research |
| Set-of-Mark (numbered overlays on segmented regions): RefCOCOg REC GPT-4V 25.7 → 86.4 with SoM (SOTA specialist 85.8); RES 75.6 mIoU vs 67.2 | https://arxiv.org/html/2310.11441 | research |
| Playwright MCP: default is the accessibility snapshot with element refs; "No vision models needed, operates purely on structured data"; "Fast and lightweight. Uses Playwright's accessibility tree, not pixel-based input"; vision/coordinate tools are opt-in (`--caps=vision`); state-changing tools return an updated snapshot | https://github.com/microsoft/playwright-mcp | shipped |
| Chrome DevTools MCP: `take_snapshot` = "text snapshot of the target page based on the a11y tree… along with a unique identifier (uid)"; click/fill take `includeSnapshot` (default false); design principles: "Return semantic summaries. 'LCP was 3.2s' is better than 50k lines of JSON" and "Reference over Value: for heavy assets (screenshots, traces, videos), return a file path or resource URI, never the raw data stream" | https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/tool-reference.md ; https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/docs/design-principles.md | shipped |
| Browser Use: `use_vision="auto"` (screenshot only when requested); `page_extraction_llm` small model for DOM extraction; the "Speed Matters" post credits optional screenshots and a DOM `extract` tool | docs and post linked in §1 | shipped OSS |
| Replit self-test: "a stripped-down DOM representation that is augmented with ARIA labels and test attributes" | https://replit.com/blog/automated-self-testing | shipped |
| Anthropic computer use: coordinate-based screenshots remain the primary observation; `zoom` action reads a region at full resolution; recommended 1024x768–1366x768; "Place the instruction text before the screenshot image… improves click accuracy" | computer use tool docs | shipped |
| Google Gemini 2.5 Computer Use: screenshot + URL + recent-action history in, one function call out | https://blog.google/technology/google-deepmind/gemini-computer-use-model/ | shipped |
| OpenAI CUA: loop is "perception (screenshots), reasoning, action"; OSWorld 38.1%, WebArena 58.1%, WebVoyager 87% — **UNVERIFIED**: openai.com returned 403 to direct fetch; numbers come from the page as indexed by search. Settle by opening https://openai.com/index/computer-using-agent/ | | shipped |

Text snapshots win on tokens, determinism, and history usefulness (OSWorld's history finding).
Screenshots stay necessary where the a11y tree is incomplete or lies (canvas, custom widgets,
iOS 26 nav items per this repo's M21); the hybrid pattern is "text by default, zoom/screenshot
on demand" (Browser Use `auto`, Anthropic `zoom`). Set-of-marks is the bridge: it keeps a
screenshot but turns grounding into picking an integer.

### 3.3 Diff-only and pruned observations

| Mechanism | Evidence | Source | Status |
|---|---|---|---|
| Browser Use marks elements new since the last step with `*[index]` (`new_prefix = '*' if node.is_new`, computed by comparing `(session_id, backend_node_id)` with the previous serialization) | code, not measured | https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/dom/serializer/serializer.py | shipped OSS |
| AgentOccam: merge label-only static text into the interactive element it describes; tables/lists to Markdown; drop `noop`, tab ops, `scroll`, `hover`, `press`, `go_forward`, `goto`; add `note`/`stop`/`branch`/`prune`; replay only "pivotal nodes" with ancestors/siblings/descendants | WebArena 16.5% → 43.1% overall; Table 4 average tokens per step actually *rose* (2,210 → 2,931) because the planning tree adds context, so the win is alignment, not raw size | https://arxiv.org/html/2410.13825 | research |
| SWE-agent collapse of observations older than the last 5 | +3 pp (Table 3) | SWE-agent | research |
| Anthropic context editing (clear stale tool results server-side) and memory tool | 100-turn web-search eval: workflows "that would otherwise fail due to context exhaustion" complete "while reducing token consumption by 84%"; context editing alone +29% on agentic search eval; with memory tool +39% | https://claude.com/blog/context-management | shipped |
| Claude Code compaction | "clears older tool outputs first, then summarizes the conversation if needed"; MCP tool definitions deferred and loaded via tool search | https://code.claude.com/docs/en/how-claude-code-works | shipped |
| Anthropic Tool Search Tool (defer tool schemas, load on demand) | ~77K → ~8.7K tokens (85% less); Opus 4 49% → 74%, Opus 4.5 79.5% → 88.1% on tool-selection accuracy | https://www.anthropic.com/engineering/advanced-tool-use | shipped |
| `response_format: concise|detailed` on tools | concise ≈ one-third the tokens of detailed; Claude Code caps tool responses at 25,000 tokens by default | https://www.anthropic.com/engineering/writing-tools-for-agents | shipped |
