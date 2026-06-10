# Plan — Daily Briefing pre-MVP (iPhone, system model)

**Goal:** a manually-triggered daily briefing on iPhone, generated entirely
on-device by the **system model** (Apple Foundation Models framework, iOS 26),
running the pipeline exactly as the future overnight job would — checkpointed,
budget-aware, resumable — and reporting hard numbers when it finishes.

This is a measurement vehicle wearing a feature's clothes. It must actually
produce the briefing note, but its primary outputs are the stats.

## Decisions this inherits (do not relitigate here)

- **Never ship model weights on mobile.** Mobile uses what the OS provides;
  devices that can't run the system model get their briefing from another
  device via sync (later) or not at all. Decided 2026-06-10.
- **iPhone first.** Android (ML Kit GenAI / Gemini Nano) gets its own pass later.
- **The digest recipe** — decided by two rounds of blind judging on the
  ml-automations branch (`docs/plan/ml-experiments.md`, "Digest config —
  DECIDED 2026-06-09"): P2 chief-of-staff prompt, C2 compact-distillation
  context, generator temperature 0.4. The generator there was gemma4:e4b;
  here it is AFM — **whether AFM holds P2/C2 quality is one of the questions
  this pre-MVP answers**, not an assumption.
- **`.generated/` layout** from `docs/plan/ml-automations.md`: machine
  artifacts live in a hidden dot-folder, invisible to `scan_notes` for free,
  single-writer, manifest-tracked, incremental by content hash.

## What this pre-MVP proves (and what it can't)

Answers:
1. **Quality** — does AFM (the iOS 26-generation ~3B model) produce a usable
   P2/C2 briefing from a real vault? (Output note is judged by Justin.)
2. **Throughput** — real ANE tok/s for distillation and digest on the target
   iPhone, measured, not folklore.
3. **Fit** — does the per-note + budgeted-context design actually live inside
   the 4,096-token window without `exceededContextWindowSize` in practice?
4. **Groundedness** — citation/hallucination rate via the digest-lab
   auto-verification check, on-device.

Explicitly **cannot** answer: the background token/request budget Apple grants
a real `BGProcessingTask` (foreground requests are unlimited; background is
budgeted and the budget is unpublished). That needs the real-scheduler probe —
first follow-up, see end.

## UX

- **Entry point:** the sync sheet (`SyncView`, presented from the
  `NoteListView` toolbar) gains a **"Labs" section** with one row: *Generate
  Daily Briefing*. No new top-level surface for a pre-MVP.
- **Tapping it** pushes/presents `BriefingView`:
  - Progress: stage label ("Distilling 4/11 — *meeting with sarah*",
    "Writing briefing…"), determinate bar across distillation, indeterminate
    for the digest pass. Streaming the digest text into the view as it
    generates is desirable (the session API supports streaming) but optional.
  - Cancel button. Cancel checkpoints; a re-run resumes (see pipeline).
  - On completion: stats summary (below) + an "Open briefing" button.
- **Output note (visible, deliberately):** `Briefings/Daily Briefing
  YYYY-MM-DD.md`. If it exists, **replace its content** (same id, `write()`).
  Create the `Briefings/` folder if missing. This intentionally deviates from
  the `.generated/daily/` design — the pre-MVP has no surfacing UI, so the
  note must appear in the normal list; sync carrying it to other devices is a
  feature, not a bug, for a demo. Long-term home remains `.generated/daily/`
  + a morning card, per the ml-automations plan.
- During a manual run, disable the idle timer (`isIdleTimerDisabled`) so the
  screen doesn't sleep and suspend the app mid-pipeline. Restore it after.

## Pipeline

All stages live in one `BriefingEngine` (Swift, `apps/ios/Sources/`), written
trigger-agnostic: the settings button calls the same entry point a
`BGProcessingTask` handler would.

```
availability → select → distill (per note, cached) → assemble C2 → digest → verify → write → stats
```

1. **Availability.** Switch on `SystemLanguageModel.default.availability` and
   stop early with a distinct, user-readable reason for each case:
   `deviceNotEligible` (device can't ever), `appleIntelligenceNotEnabled`
   (link to Settings), `modelNotReady` (try again later). Record the state in
   stats even on success.
2. **Select.** Notes with `modified` within the last **21 days**, newest
   first (mirrors the lab's C2 selection; `NoteItem.modified` exists). Cap at
   **40 notes**. mtime is a known liar (see note-dating learnings) — accepted
   for pre-MVP.
3. **Distill — one fresh `LanguageModelSession` per note.** The 4,096-token
   window counts instructions + prompts + outputs cumulatively per session;
   never reuse a session across notes.
   - **Input guard** (the 58 KB-line lesson from the entity spike): drop
     whitespace-free runs >100 chars, then truncate the body to fit — use
     `tokenCount(for:)` (iOS 26.4+) to keep instructions + body ≤ ~3,400
     tokens, leaving ≥ ~600 for output. Fallback if the API is unavailable:
     ~4 chars/token heuristic with margin.
   - **Schema:** `@Generable struct NoteDistillation` mirroring the
     ml-automations distillation schema: `note_type` (enum: meeting / task-list
     / idea / journal / reading / other), `one_line_summary`, `people: [String]`,
     `organizations: [String]`, `dates_mentioned: [String]`,
     `action_items: [String]`, `decisions: [String]`, `open_questions: [String]`.
     (`DynamicGenerationSchema` — schema-from-synced-config — is the future;
     compile-time structs are fine for pre-MVP.)
   - **Instructions** (adapted for AFM from the NuExtract template):
     > Extract structured facts from the user's note. Only state things
     > present in the note. Use empty arrays when nothing matches. Keep
     > one_line_summary under 25 words.
     Prompt = the (guarded, truncated) note body. `GenerationOptions`:
     temperature 0.0–0.2, cap response ~500 tokens.
   - **Cache & checkpoint:** before distilling, hash the note content
     (content-hash util exists in `futo-notes-core`; a local SHA-256 over the
     body is acceptable for pre-MVP). Skip if
     `.generated/briefing/distilled/<id-slug>.json` exists with the same hash.
     Write each result immediately — this is the resumability mechanism:
     cancel/crash/rate-limit loses at most one note's work, and re-running
     after a vault edit only re-distills changed notes.
   - **Rate-limit handling:** on `rateLimited`, checkpoint, stop the run,
     and surface it prominently in stats (count + which note). Do not retry-loop.
4. **Assemble C2.** Newest-first, build per-note distillation lines in the
   lab's exact format, adding lines while the *total* digest prompt
   (instructions + "Today is…" + lines) stays ≤ ~3,400 tokens:

   ```
   ### <note title>
   - type: <note_type>
   - summary: <one_line_summary>
   - people: <comma-joined>
   - open action_items:
     - <task>
   - decisions:
     - <decision>
   - open_questions:
     - <question>
   ```

   Omit empty fields. Record how many notes made the cut vs. were selected
   (silent truncation must show in stats).
5. **Digest — one fresh session.** Instructions = **P2-cos, verbatim from the
   judged winner**:
   > You are my chief of staff. From the provided notes tell me: the 3 things
   > that matter most today, anything blocked and why, and what I should do
   > next. Be opinionated and concrete. Cite note titles in parentheses.
   > Never state anything not present in the notes. Maximum 200 words.

   Prompt = `Today is YYYY-MM-DD.\n\n` + C2 bundle (lab format).
   `GenerationOptions`: temperature 0.4, `maximumResponseTokens` ~350.

   *Optional setting (default off), per the lab decision:* **P2plus** voice
   variant —
   > You are my sharp, personable chief of staff. From the provided notes
   > tell me: the 3 things that matter most today (ranked), anything blocked
   > and why, and what I should do next — opinionated and concrete. Then add
   > one short, natural closing line in my voice (a callout, a bit of levity,
   > or something fun from the notes) if there's something worth it. Cite
   > note titles in parentheses. Never invent anything not in the notes.
   > Keep it under 300 words.
6. **Verify (digest-lab auto-check, ported):** scan parenthesized citations in
   the digest against the titles actually included in the C2 bundle; flag any
   citation of an absent title and any person/org name absent from the bundle.
   Don't block the note — write it anyway and report the flags in stats.
   Groundedness is a number we want, not a gate, in a pre-MVP.
7. **Write the note** (replace semantics above), with a one-line footer:
   `*Generated on-device by Apple Foundation Models · <date time> · model may make mistakes*`.
8. **Stats** — persist to `.generated/briefing/last-run.json` (and keep the
   previous N=20 runs in `runs/`), then display:
   - Per stage and total: wall-clock ms.
   - Distillation: notes selected / distilled / skipped-cached / failed;
     prompt + output tokens per note (via `tokenCount(for:)`) and tok/s
     (output tokens ÷ generation wall time — note this is decode+overhead,
     label it "effective tok/s").
   - Digest: prompt tokens, output tokens, effective tok/s, notes included
     in C2 vs selected.
   - Verification: citation flags count + list.
   - Environment: model availability state, app foreground/background,
     `ProcessInfo.thermalState` (start/end), battery level (start/end),
     `UIDevice.batteryState` (charging or not — the "as if on the charger"
     condition is recorded, not enforced), iOS version, device model.
   - Any `rateLimited` / `exceededContextWindowSize` / other errors.

## "As if in the background" — what that means here

- The engine runs in a `Task` at **`.utility` priority** — approximating
  background scheduling for our process. (AFM inference itself runs
  out-of-process on the ANE; our QoS mostly affects the glue code.)
- **Checkpoint everything** (stage 3) so the pipeline tolerates being killed
  at any point — the property a real overnight window demands.
- Handle `rateLimited` as a first-class outcome, not an exception — in real
  background runs it's the budget boundary.
- What manual triggering **cannot** simulate: the background request budget
  and any background-QoS throttling of the model service. Hence follow-up #1.

## Code layout

```
apps/ios/Sources/
  BriefingEngine.swift     # pipeline, checkpointing, stats collection
  BriefingModels.swift     # @Generable NoteDistillation, RunStats, C2 builder
  BriefingView.swift       # progress + stats + open-note UI
  SyncView.swift           # + Labs section row (rename of sheet title optional)
```

Note access goes through the existing `NotesStore`/vault API (`scan`, `read`,
`write`, `createNote`, `createFolder`) — no FFI changes. `.generated/` files
are written directly (they're invisible to `scan_notes` by design); plain
`FileManager` under the notes root is fine for the pre-MVP.

## Verification

- Build: `just ios-native` (simulator builds; **Foundation Models needs a
  physical device with Apple Intelligence enabled** — simulator support is
  limited, so the real pass is `just ios-native-device`).
- Manual checklist (on iPhone, plugged in):
  1. Settings → Labs → Generate Daily Briefing → progress advances through
     named notes → stats appear.
  2. `Briefings/Daily Briefing <today>` exists in the list with P2-shaped
     content citing real note titles.
  3. Re-run immediately: distillation shows ~all skipped-cached; total time
     drops to ~digest-only; note content is replaced (single note, not a copy).
  4. Edit one recent note, re-run: exactly one re-distillation.
  5. Cancel mid-distillation, re-run: resumes from checkpoint.
  6. Airplane mode: everything still works (it's all on-device).
- Record in the PR: device model, iOS version, distill tok/s, digest tok/s,
  total wall-clock, citation-flag count. These numbers are the deliverable.
- Spec updates on completion (AGENTS.md convention): add the Labs entry +
  behavior lines to `docs/spec/settings.md`, with `> **Gap:**` notes for
  Android and for scheduled (non-manual) runs.

## Out of scope (pre-MVP)

- Real `BGProcessingTask` scheduling, Android, sync of `.generated/`,
  the eval suite/blind judging harness, sensitivity tiers (single-user test
  on Justin's vault; the privacy gate is REQUIRED before any aggregate
  surface ships to users), per-note caps tuning, entity resolution,
  note-dating, P2plus UI polish.

## Follow-ups, in order

1. **Background budget probe:** schedule the same engine from a real
   `BGProcessingTask` (charger + idle, overnight), log granted window, tokens
   completed, and where `rateLimited` lands. This is the number the overnight
   architecture hinges on.
2. **Quality judging:** drop the AFM briefing into the digest-lab blind-judging
   page against the gemma4:e4b anchors (D03). If AFM-26 loses badly, the
   decision tree is: wait for AFM 3 (iOS 27, fall) → re-judge, before
   reconsidering anything heavier.
3. **iOS 27 betas:** re-run stats + judging on AFM 3 when available; evaluate
   `contentTagging` use case for the distillation pass; adopt
   `LanguageModel`/`LanguageModelExecutor` shape when 27 is the floor.
4. **Android pass:** ML Kit GenAI Prompt API (Gemini Nano) version of the same
   engine + the same stats screen.
