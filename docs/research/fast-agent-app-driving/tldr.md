## TL;DR

1. Nobody has published an agent-to-app *action* channel richer than Shopify's; the closest shipped
   analogues are the OS vendors' own manifests — Android 16 AppFunctions ("the mobile equivalent of
   tools within MCP"), Windows App Actions (JSON action definitions + entities), Apple App Intents —
   all built for assistants, none for debug-time driving.
2. The one measured a11y-vs-anything latency number that matters: agent-device's Android snapshot
   went from p50 227 ms (one-shot process) to p50 5.8 ms over a persistent socket. The tree is not
   slow; process spawn and tunnel setup are. iOS physical-device runner requests sit at ~440 ms.
3. Every serious harness batches: Anthropic's computer-use loop returns many actions per response
   ("stop at the first failure"), browser-use defaults to 5 actions per step, agent-device `batch`
   runs a JSON step array in one daemon request with stop-on-error, UFO² reports 51% fewer LLM calls
   from speculative multi-action.
4. Code-mode is the batching endgame and it has numbers: Anthropic PTC −38% billed input tokens on a
   75-tool benchmark, Cloudflare 1.17 M → ~1,000 tokens for 2,500 endpoints — but Anthropic's own
   computer/browser toolsets are *excluded* from programmatic calling (`allowed_callers` direct-only).
5. Nobody streams app events to the model. Event channels exist (CDP events, MCP
   `notifications/resources/updated`, Tardis "live native app events"), but the agent still reads a
   snapshot per turn; the win comes from returning the post-action snapshot *in the action's
   response* (Playwright MCP `setIncludeSnapshot()`), not from push.
6. Turn cost is cut by shrinking observations (text snapshots ≫ screenshots at 1,000–1,800 tokens
   each), pruning in cache-preserving batches, reusing recorded scripts (agent-device: re-recording
   $1.21 vs $2.34 agent-repair median), and skills that cost ~100 tokens until used.
7. For FUTO Notes the gap is not a11y evidence (agent-device covers it) but a typed, data-dependent
   action manifest on all three shells plus a batch/script entry point — the iOS prototype has the
   right shape and is untracked.

---
