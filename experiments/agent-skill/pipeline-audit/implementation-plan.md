## 4. Implementation plan, in order

1. **C1, text receipts (CLI only).** Add one `render_result`, used for `do`, `step` and gestures.
   Tests in `main.rs` next to `diffs_render_as_change_lines_or_no_change`. Update commands.md and
   SKILL.md. Risk: agents or harnesses that parse the pretty JSON (the tool-eval `run.mjs` and
   `reset.mjs`) must pass `{"json":true}`, so grep for them first. This change is the largest win
   for the smallest diff and can ship alone.
2. **C4, fixed costs.** Justfile recipe, qa-target cache, WS timeout. Risk: the cache must not
   weaken M24. Key it on the pid's executable path and start time, verify again whenever either
   differs, and never cache a refusal. `just check-qa-input-safety` must stay green.
3. **C2 + C3, a complete and settled page diff.** Change `agentTrace.ts` so the snapshot holds
   `state()` and `diff.doc.lines`. Derive overlay and focus from elements. Settle in `recordDo`,
   and make `OpenNote` a promise. Regression tests first (M7.9): `SetFindQuery ""` must report the
   find change, `OpenNote` must report the loaded document, and `OpenSettings` must report content
   that renders late. Risks: settling adds latency, so cap it and measure the Jev sweep's app
   ms/turn. Verbs that wait on a dialog must stay on the 202 path.
4. **C7, traces.** Epoch `t` plus the page id, the new trace line, atomic writes, JSONL drive
   traces. Risk: trace size. Estimate: a result line ≈0.5 KB, plus raw page record and events
   ≈1–5 KB, which is about today's size. Rotate at 10 MB.
5. **C5, one AppState and native diffs.** Swift and Kotlin add `overlay`/`focus`/`verbs`, and the
   CLI does the generic diff for native verbs. Risks: the extra `state` call per native verb
   (≈5–100 ms), and schema drift, so register the AppState keys in `scripts/drift-registry.json`
   and add a conformance test that checks all three `state` payloads against one key list.
6. **C6, Jev.** Observation with overlay, focus and visible flagged elements; trimmed fan-out;
   schemas on change. Gate: jev-desktop-final (18/20), jev-ios-final (17/20) and
   jev-workflows-merged-5 (19/20) must not regress, and tokens per turn must fall. Risk: trimming
   the premise fan-out brings back the "renamed `work` to `work`" failure it was added for. Keep
   the premise for subjects the task names.
7. **Docs.** SKILL.md "the loop" and receipts, commands.md receipts and the platform table,
   `docs/research/agent-native-app-design.md`. Run `just check-agent-docs` and
   `just check-agent-first`.

Measure after each step with the same harnesses: `reads-after-do.mjs` (chained and separate reads
per action), `time-split.mjs` (thinking and run time per call), and the jev sweeps (app ms and
tokens per turn).
