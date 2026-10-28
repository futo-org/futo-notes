## Shape

```
futo-puppet step [Verb args]  ──▶  {receipt, observation}      one process per turn
                                        │
                                        ▼
        code builds the state + questions ──▶ Jev (one request) ──▶ code runs the chosen step
```

- **`futo-puppet step`** (new, JSON only, for programs). Runs one verb if given, then returns
  the receipt and one observation: `state`, the `actions` on this screen with their schemas,
  the sidebar's interactable `elements` (with `note=`/`folder=` ids) and the open note's
  `lines`. It waits up to 1.5 s for an opened note's document to arrive, because an editor can
  report `ready` with an empty document a frame after `OpenNote`. In-page it is one `observe`
  command in `puppetInspector.ts`; nothing else in the tool changed.
- **The controller** `experiments/agent-skill/tool-eval/jev-agent.mjs` (gitignored with the
  rest of the experiment; ~330 lines, plain `fetch`, no SDK). Per turn, one TypeSafe request
  with 16–29 questions, all over the same state:
  - `next`: a Choice over every verb on this screen, plus `click` when the task speaks of a
    mouse, plus `answer`. A verb whose required argument has no candidate is left off the
    menu, because Jev cannot pick a value nobody listed.
  - `arg:<name>`: one Choice per argument name over candidates **code** found. Note ids
    and folder paths from the sidebar rows; text, titles and queries from the task's
    backticked spans; offsets as `from-to` ranges of every occurrence of every span in the
    document (computed in code, never by Jev); insertion points as line starts and ends;
    tab positions from the tab list; closed sets (`theme`, `mode`) with a rubric per value.
    Optional arguments carry an `omit` option. `expect` is filled by code from the document
    between the chosen offsets, so a stale range refuses instead of editing.
  - `arg:mode@<noteId>`, and likewise `title`, `name` and `folderPath` (`DEPENDS_ON`): asked in
    a second request, sent only when the chosen verb took the argument this one depends on, once
    for that subject, its premise stated and the subject's current value labelled as a no-op.
    Asked once without the premise, Jev answered `foreground` for every open in "open A, then
    open B as a second tab in the foreground"; asked ahead for every subject, the request grew
    with notes × folders.
  - `rules.step` in the state: "Answer only for the next step of `task` that `history` does not
    show done." Each `arg:` question says only "Follow `rules.step`." (2026-09-25, of 7 variants
    live and in a paired offline replay: 38/38 workflows, 17% fewer tokens, argument confidence
    p10 .57 → .69 in live sweeps against a longer rule repeated in every question.)
  - `actionsDone`: a Noul, the absolute gate on stopping. `next` is relative; with the two
    competing (55/45 on "open settings and report") Jev stopped before acting. When `next` says
    `answer` but the Noul says no, the runner-up verb acts.
  - `answer`: a Choice whose options are **paths into the state Jev is reading** (`app.tabs`,
    `app.lines[3].text`, `receipt.status`, `computed.spans.bread.offsets`, …) and whose
    descriptions are the values there. What Jev picks is what code reads back. Lists are
    offered whole and element by element. `computed` holds what a model must not count or
    compute: row counts, each span's offsets and line number, wikilink targets.
  - `history` (one line per past step with its receipt status) and a slimmed `receipt`
    (verb, status, error text, what changed minus element refs and snapshot ids) go in the
    state so the model knows what it already did.
- **No turn cap.** The loop ends when Jev picks `answer` and the gate agrees. The only brakes
  are a stall detector (the same move producing the same state three times) and a wall-clock
  ceiling for unattended runs.
