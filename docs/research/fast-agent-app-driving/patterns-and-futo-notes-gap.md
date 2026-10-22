## Patterns that generalize

Mechanisms only; each is stated as the invariant it enforces.

1. **Persistent connection, request ids, version handshake.** CDP, RN dev-middleware, Detox server,
   agent-device helper sessions ("request ids and version metadata"), Maestro's loopback HTTP on
   22087. Measured payoff ~40× (227 ms → 5.8 ms) from not spawning per command.
2. **Typed verbs advertised by the running app, resolved against live state.** Shopify's
   `Name <JSON Schema>` per screen with entity ids in the name; Reactotron `onCustomCommand` with
   `ArgType`; AppFunctions/App Actions/App Intents at OS scale. The invariant: the agent never
   searches for a target, it names one.
3. **Ack carries the post-state.** Playwright `setIncludeSnapshot()`, agent-device settle-diff,
   Anthropic "attach screenshot to last result". One round trip per batch, not per action.
4. **Refs are frame-bound; stale is an error, not a guess.** agent-device ADR 0014: mutation expires
   the ref frame "immediately before the device op"; partial publications activate bounded frames.
5. **Stop-on-first-failure with a replan cursor.** Anthropic "Not executed…" fill-ins; agent-device
   `details.step` + `partialResults`; replay `--from N --plan-digest`.
6. **In-process idle detection instead of harness sleeps.** Detox, Maestro settle, Appium
   `waitForIdleTimeout`; Shopify's driver visibly does *not* wait for data, because its verbs mutate
   view-model state directly.
7. **Sandboxed script over raw tool calls when steps are predictable.** PTC/Code Mode/CodeAct;
   returns filtered output only. Not available for vendor UI toolsets — build your own runner.
8. **Static-cost discovery.** Skills' ~100-token metadata, Cloudflare `search()`, Tool Search Tool,
   Shopify `ls` scoped to the current screen: the manifest is paged, not dumped.
9. **Recorded artefacts become the reuse unit.** `.ad` fragments with digests and repair hints;
   AppAgent knowledge base; Skills' scripts. Re-recording is cheaper than agent repair.
10. **Evidence channel separate from action channel.** Tardis checkpoint screenshots/event windows;
    Shopify's frame-diff video; agent-device journal sinks. Actions go through verbs; proof comes
    from a recorder.

## What FUTO Notes already has vs lacks

Mapped against the ten mechanisms. Repo facts read from this worktree and the sibling worktree
`agent-device-futo-notes-dc3c07`; constraints from `AGENTS.md` (§4 Rust owns note rules, shells are
projections; §5 `BRIDGE_VERSION` bump discipline; §6 M10 a bridge message needs both native hosts,
M21 synthetic input lies, M24/M25 QA target and kill discipline; §11 item 6 `BRIDGE_VERSION` changes
need a stop-and-ask).

| # | Mechanism | Have | Lack |
|---|---|---|---|
| 1 | Persistent connection | Desktop debug builds ship a Tauri **MCP bridge** (`apps/tauri/AGENTS.md` §Tauri MCP: "Prefer `webview_execute_js` for deterministic automation"). Android WebView is reachable over **CDP** via `just cdp-forward` + `scripts/cdp-invoke.mjs` (`Runtime.evaluate`). | iOS has no long-lived channel in this worktree; the sibling's `PuppetServer.swift` (NWListener, `FUTO_PUPPET_PORT`, 256 KB request cap) is **untracked** (`??` in `git status`). Android's channel is `am broadcast` + one logcat ack line (`TestHookProtocol.kt`), i.e. one-shot, fire-and-read-log. |
| 2 | Typed verbs from the running app | iOS prototype: `GET /actions` returns `{name, schema}` for `OpenNote{noteId}`, `GoBack`, `SelectByFind{query}`, `ToggleBold`, `CloseFind`; `POST /do/<Name>`. Android hooks are named (`hook=` extra) and the ack lists `known=` names on a miss. Desktop `window.__testSync` exposes `connect/status/syncNow/disconnect/pauseAutoSync/resumeAutoSync`. | Manifest is a static list, not per-screen and not data-dependent (no `OpenNote:<id>` enumeration from the live cache). No shared vocabulary across the three shells; nothing in Rust, where §4 says domain verbs belong. Android hooks carry no typed args. |
| 3 | Ack carries post-state | `TestHookOutcome.Ran(payload)` can return a JSON payload. MCP bridge JS calls return values. | iOS `/do` returns `✓`-style ok/unavailable only; no screen/state in the response. No settle-diff anywhere. |
| 4 | Frame-bound refs | n/a — verbs, not refs. agent-device (used for a11y evidence) supplies this. | — |
| 5 | Stop-on-failure batch with cursor | agent-device `batch` is available for tree-level steps. | No batch endpoint on our own verb channels; the iOS server serialises one `pendingMutation` at a time. |
| 6 | In-process idle detection | Rust store mutations are synchronous and the cache is a projection of `LocalNoteMutation` (§5), so "done" is knowable in-process. | Not exposed: no "settled" signal from any shell to a driver. |
| 7 | Sandboxed script runner | Desktop: `webview_execute_js` is effectively a script runner over the app's JS surface; `tests/lib/tauri-test-client.mjs` drives it. | Nothing equivalent for native shells; no plan/step file over `/do`. |
| 8 | Static-cost discovery | `GET /actions` is small (5 entries). | No scoping by screen; will not stay small once real. |
| 9 | Recorded artefacts | `tests/ios-editor-stories.mjs`, `tests/android-storage-migration.mjs`, `tests/lib/android/testHooks.mjs` are hand-written stories. agent-device `.ad` recording available. | No recorded-then-replayed macro layer over our verb channels. |
| 10 | Evidence channel | `just journal` (JSONL `app_launch`/`sync_run` events, desktop only), `just sim-screenshot` / `emu-screenshot`, `qa-shot`, agent-device video/frame diff. | "Native shells do not journal yet" (justfile comment, `docs/spec/sync.md`). No checkpoint capture tied to verbs. |

Constraint notes for whoever acts on this: a verb channel that touches the editor must go through
`packages/editor/src/bridge.ts` (`BRIDGE_VERSION = 8`, currently additive) and land on both native
hosts in one change (M10); any new `initialize`/message shape is a §11 stop-and-ask. Verbs that
mutate notes must call Rust workflows, not stitch shell calls (§4 item 6). The Android
broadcast/logcat design was chosen so "a broadcast that reaches no app … fails at the call instead of
timing out"; a socket channel replaces that guarantee and must keep it.
