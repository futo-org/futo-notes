## 4. Pushing instead of polling

Polling costs a full iteration per check ("wait, screenshot, is it done yet?"). A push
mechanism lets the harness block until the environment says it changed, and hand the model one
observation containing the outcome.

| Mechanism | What it provides | Source | Status |
|---|---|---|---|
| MCP resources: capability `resources.subscribe`; `resources/subscribe {uri}` → server sends `notifications/resources/updated {uri}`; `resources.listChanged` → `notifications/resources/list_changed`; tools: `notifications/tools/list_changed` | Wake-on-change for any URI-addressed state; the client re-reads on notification | https://modelcontextprotocol.io/specification/2025-06-18/server/resources ; https://modelcontextprotocol.io/specification/2025-06-18/server/tools | shipped spec; client support varies (UNVERIFIED which hosts surface subscriptions to the model) |
| MCP progress: request carries `_meta.progressToken`; receiver emits `notifications/progress {progress, total, message}`; "progress value MUST increase" | Long tool calls report without the model polling | https://modelcontextprotocol.io/specification/2025-06-18/basic/utilities/progress | shipped spec |
| CDP Page events: `loadEventFired`, `domContentEventFired`, `frameNavigated`, `lifecycleEvent` ("navigation, load, paint, etc"), `frameStoppedLoading`, `javascriptDialogOpening` | Harness-level settle detection instead of fixed sleeps | https://chromedevtools.github.io/devtools-protocol/tot/Page/ | shipped |
| Chrome DevTools MCP `wait_for` ("Wait for the specified text to appear on the selected page") and README "automatically wait for action results" | Condition wait inside one tool call | tool-reference above; https://github.com/ChromeDevTools/chrome-devtools-mcp | shipped |
| Playwright MCP actions return the new snapshot | Post-action state pushed into the result | https://github.com/microsoft/playwright-mcp | shipped |
| Claude Code hooks: `PreToolUse` (can block, exit 2 or `permissionDecision: deny`), `PostToolUse` (`additionalContext`, `updatedInput`), `PostToolUseFailure`, `PostToolBatch`, `Stop` (can block ending the turn), `FileChanged` (watched file changes), `SessionStart`, `PreCompact`/`PostCompact`, and others; "hooks are deterministic and guarantee the action happens" vs advisory CLAUDE.md | Deterministic side-loop that injects verification results or blocks bad actions without a model turn; Stop hook lets a script gate completion ("Claude Code overrides the hook and ends the turn after 8 consecutive blocks") | https://code.claude.com/docs/en/hooks ; https://code.claude.com/docs/en/best-practices | shipped |
| Anthropic computer-use `wait` action, and "attach a screenshot as an extra image block on the last result in the batch… which saves a round trip" | The harness, not the model, supplies the post-settle observation | computer use tool docs | shipped |
| OpenHands event stream ("a chronological collection of past actions and observations") | Architecture where observations are events; enables replay/streaming but the paper reports no latency effect | https://arxiv.org/html/2407.16741 | research/OSS |

How this changes the loop: with push, "act" and "observe the outcome" collapse into one
iteration, and the model never spends a turn on "nothing changed yet". Measured numbers for
push-vs-poll specifically were not found in any primary source (**UNVERIFIED** magnitude);
the expected saving is one iteration per settle-wait, which §1 prices at seconds and
thousands of tokens each. For this repo, the analogous levers are the desktop MCP bridge,
`window.__testSync`, and the journal (see `docs/research/fast-agent-app-driving.md`).
