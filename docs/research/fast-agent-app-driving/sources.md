## Sources

All accessed 2026-09-11 unless noted.

Prior context
- `docs/research/shopify-agent-driving.md` (sibling worktree, 2026-09-10) — Shopify AppCLI/Tardis
  analysis, video-derived latencies, agent-device README/ADR index.

Shopify
- "Migrating Shop app from React Native to native", Shopify Engineering —
  <https://shopify.engineering/shop-app-migration> (Tardis, Pi, plan-hash quotes; 12 weeks, 6
  engineers, "10x" crash reduction).

Anthropic
- Programmatic tool calling — <https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling>
  (−38% / τ²-bench +8% / 20–40%; `allowed_callers`; computer/browser toolsets direct-only; 4-min
  timeout).
- Advanced tool use (2025-11-24) — <https://www.anthropic.com/engineering/advanced-tool-use>
  (43,588→27,297 tokens; Tool Search 85%; accuracy deltas).
- Computer use tool — <https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool>
  (batch actions, "Not executed…", 1,000–1,800 tokens/screenshot, ≤20 images, prune in batches,
  `zoom`).
- Agent Skills overview — <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
  (~100 tokens metadata, <5k body, scripts' code never enters context).
- Effective context engineering (2025-09-29) —
  <https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents> (compaction,
  tool-result clearing, 1,000–2,000-token sub-agent summaries).

Cloudflare
- "Code Mode: the better way to use MCP" (2025-09-26) — <https://blog.cloudflare.com/code-mode/>.
- "Code Mode: give agents an entire API in 1,000 tokens" (2026-02-20) —
  <https://blog.cloudflare.com/code-mode-mcp/> (1.17 M vs ~1,000 tokens; `search`/`execute`).
- "Sandboxing AI agents, 100x faster" (2026-03-24) — <https://blog.cloudflare.com/dynamic-workers/>.
- Code Mode API reference — <https://developers.cloudflare.com/agents/api-reference/codemode/>.

OpenAI
- Computer use guide — <https://developers.openai.com/api/docs/guides/tools-computer-use>
  (loop, 20-response limit, safety).
- "Computer-Using Agent" — <https://openai.com/index/computer-using-agent/> — HTTP 403 to automated
  fetch; OSWorld 38.1% / WebArena 58.1% / WebVoyager 87% taken from a search-engine snippet of that
  page (UNVERIFIED direct).

OS vendor manifests
- Android AppFunctions overview — <https://developer.android.com/ai/appfunctions>; API reference —
  <https://developer.android.com/reference/android/app/appfunctions/AppFunctionManager>; samples —
  <https://github.com/android/appfunctions>.
- Windows App Actions overview — <https://learn.microsoft.com/en-us/windows/ai/app-actions/>.
- Apple WWDC25 "Explore new advances in App Intents" —
  <https://developer.apple.com/videos/play/wwdc2025/275/>; WWDC26 "Explore advanced App Intents
  features for Siri and Apple Intelligence" — <https://developer.apple.com/videos/play/wwdc2026/343/>;
  WWDC26 "Secure your app: mitigate risks to agentic features" —
  <https://developer.apple.com/videos/play/wwdc2026/347/> (title/summary only via search). App
  Intents framework page <https://developer.apple.com/documentation/appintents> returned only its
  title to automated fetch.
- Android Studio Journeys — <https://developer.android.com/studio/gemini/journeys>.

Debug listeners and drivers
- Chrome DevTools Protocol — <https://chromedevtools.github.io/devtools-protocol/>.
- React Native dev-middleware README —
  <https://github.com/facebook/react-native/blob/main/packages/dev-middleware/README.md>; RN 0.76
  release post — <https://reactnative.dev/blog/2024/10/23/release-0.76-new-architecture>.
- Expo DevTools plugins — <https://docs.expo.dev/debugging/devtools-plugins/>.
- Reactotron custom commands — <https://docs.infinite.red/reactotron/custom-commands/>; README —
  <https://github.com/infinitered/reactotron>.
- Flipper (archived 2025-09-26) — <https://github.com/facebook/flipper>.
- Maestro: README <https://github.com/mobile-dev-inc/maestro>; "How Maestro works" —
  <https://docs.maestro.dev/get-started/how-maestro-works>; `XCTestHTTPServer.swift`, CONTRIBUTING.md
  (port 22087), `maestro-android/build.gradle.kts` (gRPC) via GitHub code search.
- Detox "How Detox works" — <https://wix.github.io/Detox/docs/articles/how-detox-works>.
- Appium XCUITest driver settings — <https://appium.github.io/appium-xcuitest-driver/latest/reference/settings/>.
- Playwright MCP README — <https://github.com/microsoft/playwright-mcp>; tool sources
  `packages/playwright-core/src/tools/backend/{snapshot,keyboard,navigate,tabs,wait,files}.ts` in
  <https://github.com/microsoft/playwright> (`response.setIncludeSnapshot()`).
- chrome-devtools-mcp README and `docs/tool-reference.md` —
  <https://github.com/ChromeDevTools/chrome-devtools-mcp>.
- browser-use README — <https://github.com/browser-use/browser-use>; agent parameters —
  <https://docs.browser-use.com/open-source/customize/agent/all-parameters>.

agent-device (callstack)
- README — <https://github.com/callstack/agent-device>; Batching doc
  `website/docs/docs/batching.md`; ADRs 0002 (persistent helper sessions, 227 ms→5.8 ms), 0003
  (daemon command registry), 0004 (iOS snapshot backends), 0012 (interactive replay), 0014 (ref
  frames), 0018 (event journal), 0020 (composable fragments, $1.21 vs $2.34);
  `docs/usbmux-runner-transport-experiment.md` (350–450 ms / 440 ms / 4.5 s idle tax);
  `docs/ios-runner-protocol-optimizations.md` (plan, no measurements). Callstack's blog on
  agent-device optimisation returned 403 (also noted in the sibling file).

MCP
- Resources (subscribe / updated / list_changed) —
  <https://modelcontextprotocol.io/specification/2025-06-18/server/resources>.
- Sampling — <https://modelcontextprotocol.io/specification/2025-06-18/client/sampling>.

Research papers
- UFO² "The Desktop AgentOS" — <https://arxiv.org/abs/2504.14603>; UFO README (51% fewer LLM calls)
  — <https://github.com/microsoft/UFO>.
- Windows Agent Arena — <https://arxiv.org/abs/2409.08264>.
- OmniParser — <https://arxiv.org/abs/2408.00203>; V2 post (2025-02-12) —
  <https://www.microsoft.com/en-us/research/articles/omniparser-v2-turning-any-llm-into-a-computer-use-agent/>.
- CodeAct — <https://arxiv.org/abs/2402.01030>. Voyager — <https://arxiv.org/abs/2305.16291>.
- AppAgent — <https://arxiv.org/abs/2312.13771>. DroidBot-GPT — <https://arxiv.org/abs/2304.07061>.
- Mobile-Agent — <https://arxiv.org/abs/2401.16158>; Mobile-Agent-v2 — <https://arxiv.org/abs/2406.01014>.
- AndroidWorld — <https://arxiv.org/abs/2405.14573>.

Industry
- Uber, "DragonCrawl: Generative AI for High-quality Mobile Testing" —
  <https://www.uber.com/blog/generative-ai-for-high-quality-mobile-testing/>.
- Airbnb engineering posts found concern LLM *test migration* and evaluation, not app driving (e.g.
  <https://medium.com/airbnb-engineering/accelerating-large-scale-test-migration-with-llms-9565c208023b>);
  no Meta first-party post on agent-driven app QA was found (Flipper archived; Sapienz predates
  LLMs). Recorded as absence, not evidence.

Repo (this worktree unless noted)
- `AGENTS.md`, `apps/tauri/AGENTS.md` §Tauri MCP, `src/features/sync/testSync.ts`,
  `scripts/cdp-invoke.mjs`, `scripts/android-drive.mjs`, `scripts/qa-target.mjs`,
  `apps/android/app/src/debug/java/com/futo/notes/testhook/TestHookProtocol.kt`,
  `packages/editor/src/bridge.ts` (`BRIDGE_VERSION = 8`), `justfile` (`journal`, `cdp-forward`).
- Sibling worktree `agent-device-futo-notes-dc3c07`: `apps/ios/Sources/App/PuppetServer.swift`
  and `apps/ios/Tests/App/PuppetServerContractTests.swift` (both untracked).
