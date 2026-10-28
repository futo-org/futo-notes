# How fast agent-driven app control is built elsewhere

Desk research, 2026-09-11. Builds on `shopify-agent-driving.md` (2026-09-10), which established that
Shopify's fast path is a typed per-screen action REPL (`ls` / `do <Name> <json>`) over an in-app
command listener, and that Shopify has published nothing about how the *agent* avoids one
deliberation turn per action. This file answers the wider question: what everyone else does, with
numbers where they exist. Every claim is labelled **OBSERVED** (primary source, cited), **INFERRED**
(deduction, with confidence), or **UNVERIFIED** (could not reach a primary source; says what would
settle it). Shipping status is tagged **[prod]** (shipped in a product), **[oss]** (public source
you can run), **[paper]** (research result), **[demo]** (video/announcement only).

- [TL;DR](fast-agent-app-driving/tldr.md) — the seven findings in one list.
- [Q1. In-app listeners and manifests](fast-agent-app-driving/in-app-listeners-and-manifests.md) —
  OS manifests (AppFunctions, App Actions, App Intents), debug-time listeners (CDP, React Native,
  Expo, Reactotron, Maestro, Detox, agent-device), and how their manifests compare.
- [Q2. A11y vs semantic latency](fast-agent-app-driving/a11y-vs-semantic-latency.md) — the numbers
  that exist, and where vision, a11y trees and semantic verbs each win.
- [Q3. Batching and scripting actions](fast-agent-app-driving/batching-and-scripting.md) — action
  arrays, step files and DSLs, code mode.
- [Q4. Streaming events instead of polling](fast-agent-app-driving/streaming-events-to-the-agent.md)
  — the event channels that exist, and what actually reaches the model.
- [Q5. Cutting the LLM-turn cost](fast-agent-app-driving/cutting-llm-turn-cost.md) — fewer turns,
  smaller observations, cache-aware pruning, hierarchical planners, skills, cheaper models.
- [Patterns; FUTO Notes has vs lacks](fast-agent-app-driving/patterns-and-futo-notes-gap.md) — ten
  mechanisms, then each one mapped against this repo.
- [Open questions](fast-agent-app-driving/open-questions.md) — what the sources do not answer.
- [Sources](fast-agent-app-driving/sources.md) — every source, grouped by vendor and kind.
