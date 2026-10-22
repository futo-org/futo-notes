## Open questions

1. Shopify's transport and whether AppCLI has a batch/plan mode — still unpublished; the deep-dive is
   the only thing that will answer it.
2. Does any production agent consume a push event stream mid-turn, or is Tardis strictly
   checkpoint-and-compare? (Tardis source or a Shopify talk.)
3. Absolute XCUITest snapshot latency on a simulator for an app of our size — agent-device gives only
   "many seconds" for pathological trees; measuring `xcrun`/XCTest vs the host AX bridge on our app
   would settle whether the a11y leg is a real cost here.
4. Can Apple App Intents be enumerated and invoked from a harness on a debug build (Shortcuts CLI,
   Xcode test targets), making them a free iOS manifest? Nothing in the WWDC25/26 transcripts says
   so.
5. Will Anthropic lift the direct-only restriction on `computer_toolset`/`browser_toolset` for PTC?
   Until then, scripting UI actions means a harness-owned runner.
6. Where should a per-screen, data-dependent manifest live for us — Rust (`futo-notes-store`
   enumerates `OpenNote:<id>`), shells (navigation verbs), or both — and how is "current screen"
   represented on desktop where the Svelte router is the truth?
7. Reactotron's transport and whether its `onCustomCommand` registry has an over-the-wire manifest
   format worth copying verbatim (read `reactotron-core-client`).
8. OpenAI's CUA page and Callstack's optimisation blog both refused automated fetch (403); their
   numbers are quoted here only via search snippets and should be re-read by a human.
