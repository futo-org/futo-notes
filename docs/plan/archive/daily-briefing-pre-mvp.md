# Plan — Daily Briefing pre-MVP (iPhone, system model)

**Goal:** a manually-triggered daily briefing on iPhone, generated entirely
on-device by the **system model** (Apple Foundation Models framework, iOS 26),
running the pipeline exactly as the future overnight job would — checkpointed,
budget-aware, resumable — and reporting hard numbers when it finishes.

This is a measurement vehicle wearing a feature's clothes. It must actually
produce the briefing note, but its primary outputs are the stats.


Archived proposal, not current shipping behavior. Full design and implementation sketch:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/plan/archive/daily-briefing-pre-mvp.md
```

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
- **`.generated/` layout** from `docs/plan/archive/ml-automations.md`: machine
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
