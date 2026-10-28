## 7. Implementation plan: ordered, test-first

Each step is red first, then green, then run through its owner chain (AGENTS.md §7).

1. **The AppState key fixture, and desktop `state()` producing AppState v1.**
   - Red: an `agentInspector.test.ts` test asserts the keys equal
     `fixtures/app-state-keys.json`, that `find` is null while closed, that `note` is present,
     that `vault` is present, and that there is no `snapshot`.
   - Green: reshape `state()` and the shell provider, adding settings, sync and vault. Stub
     `overlay: []` and `focus` from `view.hasFocus` until sibling (b) lands.
   - Add the drift-registry entry.
   - Risk: Jev's rubric strings name the old paths (`app.editor.selection.empty` in `Copy`,
     `app.editor.clipboard` in `Paste`). Update them in the same commit (step 5 re-gates them).
2. **CLI `diff_states` + `render_result` + the state store.**
   - Red: `main.rs` fixture tests. Pairs of AppStates for examples 1, 3, 5, 6 and 7 of §3.1 must
     render exactly the lines shown there; example 5 prints `no change` today.
   - Green: `act` = state → do → state; the content-addressed write; `state @id`; `--json`.
   - Harnesses that parse `do` JSON must pass `--json`. Only experiments use it; `step` stays
     JSON.
   - Risk: the 1.5 KB cap hiding a real change. The `--json` escape and the trace keep everything.
3. **Settle (audit C3).**
   - Red: `OpenNote`'s result has the document's lines, and an empty note's result does not wait
     1.5 s.
   - Green: `editor.loading` is truthful, `OpenNote` resolves once loaded, and each verb gets a
     flush plus 2 rAF, capped at 300 ms. Then delete the step loop.
   - Risk: added latency. Measure app ms/turn on the Jev sweeps; the budget is +50 ms median.
4. **Native AppState.**
   - Red: the Swift/Kotlin contract tests assert against the same key fixture and against no
     `snapshot`; `note` is present on the editor screen.
   - Green: `stateObject` adds note, overlay (from sheet or `modalUp`), focus, verbs, vault and
     nulls.
   - Native receipts then get diffs from step 2 with no further change. Check GoBack on a claimed
     simulator and emulator.
   - Risk: the phone `state` round trip. Measure it; the budget is 50 ms.
5. **Jev lean request.**
   - Red, in `jev-drive.test.mjs`:
     - a size budget on 3 recorded observations (≤ 25 KB request);
     - "every recorded move's argument is still offered", on the same fixtures;
     - "`fillArguments` uses the plain question when no premise was asked".
   - Green: Q1–Q4, `last` = `ActionResult.changed`, the schema cache, visits by id, and stored
     turns keep a copy rather than a reference (N2).
   - Gate: jev-desktop-final ≥ 18/20, jev-ios-final ≥ 17/20, workflows-merged ≥ 19/20, and a
     median of ≤ 6.5k tokens/turn.
   - Risk: Q2 bringing back "renamed `work` to `work`". The premise stays for named subjects, and
     the sweep has that task.
6. **Docs and deletions** (§6). Run `just check-agent-docs`, `just check-agent-first` and
   `just check`.

Measure after steps 2, 4 and 5 with `reads-after-do.mjs`, `time-split.mjs` and the three Jev
sweeps.
