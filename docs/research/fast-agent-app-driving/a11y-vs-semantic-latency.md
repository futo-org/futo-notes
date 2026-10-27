## Q2. Accessibility-tree drivers vs semantic action layers — measured latency

### Numbers that exist

OBSERVED — agent-device ADR 0002 (Android snapshot benchmarks): "launcher snapshot: one-shot p50
`227ms`, persistent socket p50 `5.8ms`"; "React Navigation playground snapshot: one-shot p50
`265.7ms`, persistent socket p50 `16.5ms`". Rationale: "process/session startup dominates
steady-state latency" because "some platform automation backends are expensive to start but cheap
to reuse".

OBSERVED — agent-device usbmux experiment (physical iOS, runner request round-trip): network tunnel
"350–450 ms" steady, "4.5–4.6 s" after a 40-second idle (tunnel re-probe); USB "440 ms" steady and
unchanged after idle; Wi-Fi only "425–495 ms". Conclusion: USB-first to kill the "~4.5 s per idle
gap" tax; steady-state "a wash".

OBSERVED — agent-device ADR 0004 (iOS): XCTest recursive `XCUIElement.snapshot()` "can make XCTest
fail with `kAXErrorIllegalArgument` or main-thread timeouts while the same app remains visually
usable" and can "grind for many seconds on heavy/animating screens"; hence a host accessibility
bridge for simulators. No numbers.

OBSERVED — Appium XCUITest driver settings, i.e. the knobs a mature a11y driver needs:
`snapshotMaxDepth` default 50 ("Lower values can help speed up source retrieval and prevent out of
memory or timeout errors"), `pageSourceExcludedAttributes` ("Excluding certain expensive attributes
(e.g. `visible`) may speed up page source retrieval"), `waitForIdleTimeout` default 10 s,
`animationCoolOffTimeout` default 2 s. INFERRED (high): those defaults are the latency floor of a
naive XCUITest loop — up to 12 s of idle/animation waits per action before the tree is even read.

OBSERVED — Shopify (sibling file, video-derived): `ls` manifest ≈100–200 ms terminal-observed; six
screen transitions in ~4 s "real-time (not sped up)" with skeleton loaders still on screen, i.e. the
driver does not wait for data.

OBSERVED — agent-device `batch` doc example (illustrative response, not a benchmark):
`open 1020 ms, wait 320 ms, click 260 ms, get 210 ms`, total 1810 ms for four steps over one daemon
request.

OBSERVED — Anthropic computer-use docs: "Screenshots consume ~1,000–1,800 input tokens each"; keep
≤20 images per request. OpenAI's computer-use guide caps a run at "the 20-response limit". These
are the observation-cost side of the vision loop, not wall-clock.

OBSERVED — OmniParser V2 (Microsoft Research, 2025-02-12) "reduces the latency by 60% compared to
the previous version"; no absolute seconds on the fetched page (UNVERIFIED: the GitHub README is
said to give s/frame per GPU; the fetched README lacked it).

### Where each wins

- **Vision/screenshot** (OpenAI CUA, Anthropic computer use, Google Journeys, Mobile-Agent): wins
  only when there is no tree — canvas, games, custom-drawn controls, "what does it look like"
  questions. Costs 1–2 k tokens per observation and one model turn per action unless batched.
  Benchmarks put general-purpose vision agents at OSWorld 38.1% (OpenAI CUA, per search snippet of
  openai.com — the page returned 403 to automated fetch, so UNVERIFIED direct), Windows Agent Arena
  "19.5% … compared to 74.5% performance of an unassisted human" [paper], AndroidWorld "30.6%"
  [paper].
- **Accessibility tree with refs** (Playwright MCP, chrome-devtools-mcp, agent-device, Maestro,
  Appium, Uber DragonCrawl): wins on determinism and token size. Google's chrome-devtools-mcp tool
  text says it outright: "Always use the latest snapshot. Prefer taking a snapshot over taking a
  screenshot." Playwright MCP: "Uses Playwright's accessibility tree, not pixel-based input." Uber's
  DragonCrawl fed "the text representation of the current screen" to a 110 M-parameter MPNet and
  reached "99%+ stability in November and December 2023", passing in "85 of" 89 cities and blocking
  "ten high-priority bugs" in three months [prod]. The cost is the *staleness problem* — agent-device
  ADR 0014 exists because "A mutation can change the device without capturing another tree, leaving
  the old positional refs apparently current"; "A false successful tap on the new screen is worse
  than a clear stale-ref failure."
- **Semantic action layer** (Shopify AppCLI, UFO² API mode, OS manifests): wins when the agent can
  plan without looking — no tree read, no ref resolution, no staleness class of bug. UFO² makes the
  hybrid explicit: "a unified GUI--API action layer" with "Windows UIA, Win32, WinCOM native
  control", i.e. call Word's COM API where it exists and click where it does not. Loses the moment
  the question is rendering ("did the spinner appear?") — Shopify's own bug-fix demo proved that with
  frame-diff video (sibling file).

INFERRED (high): per-action wall-clock is dominated by transport setup and idle waits, not by tree
size. Persistent sockets (5.8 ms) beat spawning (227 ms) by ~40×; a semantic verb beats a tree read
mainly by removing the *turn* that reads it, not by being faster on the wire.
