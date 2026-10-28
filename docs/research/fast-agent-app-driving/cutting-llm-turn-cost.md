## Q5. Cutting the LLM-turn cost

Mechanisms with a number attached, grouped by lever.

**Fewer turns.** Action arrays with stop-on-first-failure (Anthropic computer use); UFO² "51% fewer
LLM calls"; agent-device `batch` 5–20 steps; PTC "N (one per region) to 1" round trips; Shopify's
plannable manifest (no read step). Browser-use `flash_mode` drops the per-step evaluation/thinking
fields entirely.

**Smaller observations.** Text tree instead of pixels (Playwright/chrome-devtools "prefer snapshot");
diff instead of tree (agent-device `--settle`); ≤20 images and "1024×768, 1280×720, or 1366×768"
displays (Anthropic); PTC filters results in the sandbox — "shrinking what Claude needs to reason over
from hundreds of kilobytes down to a handful of lines"; Cloudflare `search()` so "the spec itself
never enters the model's context"; Anthropic Tool Search Tool "85% reduction in token usage" and
accuracy "49% to 74%" (Opus 4) / "79.5% to 88.1%" (Opus 4.5) on many-tool setups.

**Caching-aware pruning.** Anthropic: "Prune in *batches*, not every turn (preserves prompt cache)",
e.g. "keep last 3 screenshots, prune every 25 turns", or server-side tool-result clearing so
thinking blocks are not invalidated. The context-engineering post calls tool-result clearing "one of
the safest lightest touch forms of compaction" and describes compaction as summarising a
near-full window and "reinitiating a new context window with the summary".

**Hierarchical planners.** UFO² "HostAgent + AppAgents" [oss]; Mobile-Agent-v2 planning / decision /
reflection agents, "over a 30% improvement in task completion compared to the single-agent
architecture" [paper]; Anthropic sub-agents returning "condensed summaries (typically 1,000-2,000
tokens)"; Shopify's Pi subagents ("inspected the React Native source, documented its behavior,
prepared platform plans, implemented features, and reviewed parity").

**Skills / macros learned from prior runs.** Anthropic Agent Skills: metadata "~100 tokens per
Skill" always loaded, SKILL.md "Under 5k tokens" on trigger, scripts run via bash so "the script code
itself never enters context" [prod]. agent-device `.ad` fragments with `include` pinned to a content
digest; re-record at "$1.21" versus "$2.34 repair median" [oss]. AppAgent's exploration phase
"generates a knowledge base that the agent refers to for executing complex tasks" [paper]. Voyager's
executable skill library [paper]. Uber DragonCrawl: no per-app scripts at all — the model generalised
to "85 of" 89 cities with "no maintenance required" versus teams spending "30–40% of their time on
maintenance" on scripted suites [prod].

**Cheaper model per step.** DragonCrawl: "MPNet (base)" ~110 M parameters chosen over T5-11B for
speed [prod]; MCP sampling `speedPriority` / `costPriority` hints exist for exactly this routing.
