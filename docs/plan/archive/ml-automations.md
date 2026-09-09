# Plan — ML Automations (Overnight Intelligence)

**Goal:** a set-and-forget companion that churns through your notes overnight and
produces something useful by morning. First target is a single concrete user:
Justin's home PC (Linux, AMD RX 7600 XT) running entity extraction over his real
vault, then daily "good morning" summaries. Everything else (mobile, hosted,
MCP recipes) layers on the same architecture later.

The demo'd-at-SXSW experience — a server runs automations on your notes
overnight — but rebuilt so it survives E2EE.


Archived proposal, not current shipping behavior. Full design and implementation sketch:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/plan/archive/ml-automations.md
```

## The mental model: the automation runner is a trusted client, not the server

The sync server stays dumb and blind (opaque encrypted blobs). The thing that
runs automations is **just another device in the sync mesh**: it authenticates,
holds a key like any phone or laptop, pulls blobs, decrypts locally, runs
recipes, writes results back. Nothing about E2EE changes.

Hosted ladder (decided, in order — nothing built now is wasted):

1. **Now:** hosted = coordination only (scheduling, push "your digest is
   ready"). Compute runs on trusted devices the user owns.
2. **Maybe later:** explicit opt-in tier where the user provisions a key to a
   hosted worker, with a consent screen that says plainly what it weakens.
   Same companion software either way.


## Recorded design decisions

- One Rust companion reuses the shared note, sync, and search owners. Start with a
  one-shot runner, systemd timer (cron fallback), and OS-keyring credentials; daemon,
  MCP, macOS, and Windows scheduling are later adapters.
- Generated outputs live under hidden `.generated/`, with a single writer and
  model/version/source-hash manifests for incremental reruns. They do not currently
  sync; transporting artifacts and the configuration file requires a separately
  approved sync-payload change. The configuration filename remains undecided.
- The proposed pipeline is GLiNER for corpus entities, NuExtract3 for structured
  extraction, and a general model for digest prose. The desktop AMD experiment uses
  llama.cpp/Vulkan for GGUF inference. Evaluate model licenses before distribution;
  the proposal excluded noncommercial GLiNER variants.
- Mobile uses system models, never bundled weights. The separate daily-briefing
  experiment measures iPhone quality, throughput, and background feasibility.
- Phases: prove entity extraction on the real corpus; add scheduled incremental
  runs; measure useful daily digests; then consider artifact sync and MCP.

## Open questions recorded with the proposal


- `ort` rc.9 (gline-rs) vs rc.12 (workspace) — align or vendor.
- Sync payload extension for non-`.md` hidden files: size limits, blob typing,
  how clients ignore artifact conflicts.
- Config file location/name (`.automations/` vs inside `.generated/`).
- WWDC 2026 may change the iOS answer; Android Gemini Nano prompt-API access
  needs a research pass when mobile becomes active.
- NuExtract3 has no ONNX — accepting llama.cpp as a second runtime on desktop
  is a deliberate trade (GGUF + Vulkan is the lowest-friction path on AMD).
- GPU thermal/power: an overnight batch on the 7600 XT is sustained load;
  Vulkan path needs no ROCm install but also no power tuning — observe first
  run.
