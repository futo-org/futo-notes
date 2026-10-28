You are improving `futo-puppet`, the command-line tool an AI agent uses to drive and read a running FUTO Notes desktop app. An evaluation just ran: a Sonnet agent, given only this tool and the reference below, attempted multi-step tasks. You have its scores, its feedback, and the full transcripts of the tasks it failed. Your job is to change the tool so the next sweep does better — on these tasks and on a held-out set you cannot see, so fix the general affordance, never the specific task.

# Principles (anthropic.com/engineering/writing-tools-for-agents)

- Agents have limited context. A tool returns what the agent needs to act next, not everything it could. Prefer contextual relevance over flexibility; natural names over cryptic identifiers.
- Consolidate: when transcripts show the same sequence of calls again and again, one verb or subcommand that does the whole workflow beats three that must be chained. `schedule_event` over `list_users` + `list_events` + `create_event`.
- Errors are actionable: say what went wrong and what to do instead, never a bare code.
- Descriptions are written for a new hire: make implicit conventions explicit (id formats, offsets vs lines, what a receipt's fields mean). Unambiguous argument names.
- What agents omit in their feedback matters as much as what they say. Read between the lines of the transcripts: redundant calls mean the output did not carry what they needed; repeated argument errors mean the description did not say.
- Do not overfit: no special cases for a task's wording.

# What you may change

- `crates/futo-puppet/` — the CLI: subcommands, rendering, usage text (`USAGE`), hints. New subcommands are welcome when transcripts justify them.
- `src/app/puppet/` — the in-page inspector, registry, elements, trace: queries, receipts, refusals.
- `registerPuppetVerbs(...)` blocks inside `src/**` components — verb names, arguments, receipts, refusals; **new verbs** are welcome when a UI capability has no verb or needs a consolidated one. Every DOM handler must remain a verb (`just check-puppet-verbs`); presentation-only exceptions go in `scripts/puppet-verbs-allowlist.json` with a reason.
- `.claude/skills/puppet/references/commands.md` and `gotchas.md` — the reference the agent reads. Keep it and `USAGE` self-consistent with the code in the same change.
- `docs/research/agent-native-app-design.md` when a design fact changes.
- Tests beside what you change: `crates/futo-puppet/src/tests/*.rs` and the per-module tests, `src/app/puppet/*.test.ts`.

# What you must not change

- Product behaviour the user sees: no edits to note rules, saving, sync, rendering, `apps/`, `packages/`, other `crates/`, `docs/spec/`, `languages/`, `tests/`. The filename IS the title (AGENTS.md M2). Never weaken dev/prod data guards (M3).
- The evaluation harness under `experiments/`. Do not run it; the driver does.
- Never kill processes by name (`pkill`, `killall`) — other checkouts share this machine (M25). Never send OS-level input to the app.

# How to verify

- `cargo build -p futo-puppet && cargo test -p futo-puppet`
- `pnpm exec vitest run src/app/puppet`
- `just check-puppet-verbs && just check-agent-docs && just check-puppet-first`
- The desktop dev app of this worktree is running. `just puppet state|actions|elements|doc|show|do …` drive it. TS edits hot-reload it. `node experiments/agent-skill/tool-eval/reset.mjs` puts it back on the fixture vault (welcome, grocery list, work/standup, work/q3 plan, recipes/pancakes). Use it to try what you built.
- The driver runs `just check` after you finish; a red check rejects the round.

# Finish

End with two blocks:

<changes>
One paragraph, imperative mood, naming each change and the transcript evidence for it — suitable as a commit body.
</changes>

<hypotheses>
- one line per change: which failure it should remove, and what metric should move
</hypotheses>

# Evaluation results

{{REPORT}}

# Transcripts of the failed tasks

Each transcript is the agent's commands, in order, with the tool's output (truncated), then the agent's own summary and feedback.

{{TRANSCRIPTS}}
