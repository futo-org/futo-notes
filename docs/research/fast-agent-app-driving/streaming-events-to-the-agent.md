## Q4. Streaming app state and events to the agent instead of polling

OBSERVED — the channels exist:

- CDP: every domain "generates" events on the same WebSocket as commands (Q1).
- MCP resources: servers declaring `"resources": { "subscribe": true, "listChanged": true }` accept
  `resources/subscribe { uri }` and emit `notifications/resources/updated { uri }` and
  `notifications/resources/list_changed`; the spec's flow is "Server--)Client: updated" then
  "Client->>Server: resources/read" — a change *signal*, not a diff payload.
- MCP sampling: `sampling/createMessage` lets a server ask the client's model for a completion, with
  "there **SHOULD** always be a human in the loop with the ability to deny sampling requests".
- Tardis: "structured access to live native app events, logs, and state" plus "raw event capture"
  windows compared at checkpoints (Shop-app post).
- agent-device ADR 0018: "One **journal** per scope is the single append point"; "Every consumer is
  a **sink**: explicitly registered at scope construction, invoked synchronously in registration
  order"; "**Progress streaming is not journal-owned.**" — an observability spine, "**not** a source
  of truth".
- Detox: in-process idle monitoring of network/timers/animations so the harness is told when the app
  settled rather than polling.

OBSERVED — what actually reaches the model is still a snapshot per turn, delivered *with the
action*: Playwright MCP's mutating tools call `response.setIncludeSnapshot()` (click, drag, hover,
select_option, navigate, tabs, wait, file upload; keyboard only on Enter/submit — playwright-core
`src/tools/backend/*.ts`), so one tool result carries both the ack and the new tree. agent-device's
`--settle` returns a diff ("The diff includes:" new/removed/unchanged) and its guidance is "use the
refs in its diff, and take a new snapshot only if the diff omits what you need". Anthropic's advice
is the same shape: attach the screenshot to the last action's result "to save a round trip".

UNVERIFIED — any production agent that consumes a *push* stream of app events mid-turn. Tardis is
described as event *access* and checkpoint *windows*; no source shows an LLM being woken by an event.
What would settle it: Shopify's promised deep-dive, or Tardis source.

INFERRED (high): LLM turns are request/response, so push only helps a *harness* (idle detection,
crash detection, journal for post-hoc diff); the model-facing win is "response includes the
post-state" and "diff instead of full tree". INFERRED (medium): an event journal is the cheapest
thing to add because it needs no model changes and turns "did X happen" into a grep, which is what
Tardis' event-window comparison is.
