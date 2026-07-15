# Plan — ML Automations (Overnight Intelligence)

**Goal:** a set-and-forget companion that churns through your notes overnight and
produces something useful by morning. First target is a single concrete user:
Justin's home PC (Linux, AMD RX 7600 XT) running entity extraction over his real
vault, then daily "good morning" summaries. Everything else (mobile, hosted,
MCP recipes) layers on the same architecture later.

The demo'd-at-SXSW experience — a server runs automations on your notes
overnight — but rebuilt so it survives E2EE.

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

## One Rust binary

The companion is a single binary on the shared crates
(`futo-notes-{model,sync,search,inference,core}`):

```
futo-notes setup        # TUI: login → checkbox list of automations → installs schedule
futo-notes run          # one-shot: sync down → run enabled automations → write .generated/ → exit
futo-notes mcp          # stdio MCP server (Claude Code / Desktop / Cursor) — later
futo-notes serve        # daemon: scheduler + web UI — later, if ever needed
```

This subsumes the TS MCP spike (`futo-notes-cli-spike/apps/mcp`), which carries
its own sync client + MiniSearch — exactly the duplicated stack the Rust
unification retired on desktop. Recipes map onto MCP *prompts*: a recipe is
(prompt template, allowed tools, schedule, output target), defined once, usable
both scheduled-overnight and interactively from an MCP host.

### Set-and-forget UX

Install script drops the binary and runs `setup`: E2EE login (key into the OS
keyring — Secret Service on Linux), pick automations, done. Setup installs a
schedule and the user never thinks about it again.

**Scheduling = one-shot `run` + a thin per-platform adapter.** The binary's
core is a one-shot command; *anything* that can invoke it works:

- **systemd user timer** (default): `OnCalendar=03:00`, `Persistent=true` so a
  missed night catches up at next boot. Covers Fedora/Ubuntu/Debian/Arch/
  openSUSE — effectively all desktop Linux.
- **No systemd** (Void/Alpine/Gentoo-OpenRC/Devuan): `setup` detects it and
  prints the crontab line instead. That demographic knows cron.
- **macOS launchd / Windows Task Scheduler**: later, same adapter pattern.

One-shot + timer beats a long-running daemon: nothing to leak, nothing to crash
at 2am, journald logs, survives reboots. The scheduler is not load-bearing.

### Settings = a file

Automation config lives in a file in the vault (e.g. `.automations/config.json`
or alongside `.generated/` — TBD). The companion reads it each run. Once sync
carries non-`.md` hidden files (see gap below), "change settings from any
client" falls out for free: a client's settings page edits the synced file, the
companion picks it up next run. No new protocol.

## Artifacts: `.generated/`, not notes

Automation outputs are **not** regular notes — they'd pollute the list and some
outputs are structured (JSON). They live in a hidden folder:

```
.generated/
  entities/entities.json      # corpus-wide entity index
  entities/manifest.json      # model+version, per-note source content hash
  daily/2026-06-05.md         # good-morning note (markdown, but not a "note")
```

Repo facts that shape this:

- the note scan already skips dot-entries (`crates/futo-notes-store/src/vault.rs`,
  the `walk`/`visible` filter),
  so `.generated/` is invisible to every client's note list **today, for free**.
- The sync orchestrator skips hidden dirs **and** only syncs `.md`
  (`crates/futo-notes-sync/src/sync/vault.rs`, `local_files`/`walk` +
  `is_syncable_filename`). So generated artifacts
  **do not sync yet**. Fine for the PC-local phase; becomes a work item the
  moment the phone should wake up to a digest (> **Gap:** sync payload must
  learn to carry `.generated/` + the config file).
- Per-automation manifests record model+version+source content hash
  (`futo-notes-core` already does content hashing) → reruns are **incremental**:
  only re-process notes whose hash changed. This is what makes nightly runs
  cheap after the first one.
- Conflict story is simple: `.generated/` is single-writer (the companion);
  clients treat it as read-only.

Surfacing in clients comes later (e.g. a "good morning" card in the UI rather
than a list entry) — enabled by, not blocked on, this layout.

## Model strategy

### Decided: two models, two jobs, staged pipeline

| | **GLiNER** (entity sweep) | **NuExtract3** (structured extraction) |
|---|---|---|
| What | 200–460M encoder, zero-shot NER: give labels ("person", "project"), get spans | 4B LLM (Qwen3.5 base): give a JSON schema, get structured JSON |
| Models | [`urchade/gliner_*-v2.1`](https://huggingface.co/urchade/gliner_large-v2.1) (Apache-2.0), [`knowledgator/gliner-multitask-large-v0.5`](https://huggingface.co/knowledgator/gliner-multitask-large-v0.5) (Apache-2.0, + relations/keyphrases). **Avoid v1/PII variants — cc-by-nc.** | [`numind/NuExtract3`](https://huggingface.co/numind/NuExtract3) + [official GGUFs](https://huggingface.co/numind/NuExtract3-GGUF) Q4–Q8 (2.7–4.5 GB), all Apache-2.0 |
| Runtime | [`gline-rs`](https://github.com/fbilhaut/gline-rs) — Apache-2.0 Rust engine on `ort`, slots next to our SPLADE encoder. Official int8 ONNX on [onnx-community](https://huggingface.co/onnx-community/gliner_multi-v2.1) | llama.cpp (**Vulkan** backend on the 7600 XT — gfx1102 is not in ROCm's support matrix; `HSA_OVERRIDE` works but breaks across ROCm releases). No ONNX exists |
| Hardware | **CPU is enough**: ~6.7 seq/s (large model, gline-rs) → whole vault in minutes; int8 small is several× faster. Small enough for in-app mobile someday | Earns the GPU: ~50–90 tok/s gen, ~600 t/s prefill on Vulkan → ~2 s per 1k-token note |
| Limits | 384-token window → chunk + merge spans; label-driven, not open discovery | Schema-bound (has a template-generation mode to auto-derive schemas); 131k context |
| Quality data point | GLiNER-L 60.9 F1 zero-shot OOD vs ChatGPT 47.5 | Beats Qwen3.5-9B by ~17 pts on NuMind's extraction bench at half the size |

They're stages, not competitors:

1. **GLiNER** builds the corpus-wide entity graph nightly (who/what/where
   appears across the vault).
2. **NuExtract3** distills recently-edited notes into structured JSON (action
   items, decisions, dates, commitments) — feedstock for the digest.
3. A general LLM writes the good-morning prose from those artifacts (later;
   native OS model where it exists → Ollama if running → embedded llama.cpp).

Also noted: [`numind/NuNER_Zero`](https://huggingface.co/numind/NuNER_Zero)
(MIT, 125M) is GLiNER-architecture — likely loads in gline-rs, worth comparing
against gliner_multi-v2.1 on the real corpus. GLiNER2 (Fastino, 2048-token
context) exists but has no official ONNX yet — not v1 material.

### Mobile (later)

Native OS models, not shipped weights:

- **iOS:** Apple Foundation Models (iOS 26+) — on-device ~3B, free, guided
  generation (`@Generable`) is a natural fit for extraction. Check WWDC 2026
  (June 8–12) output before committing the design. Verify background
  rate limits (`BGProcessingTask` is opportunistic: charging + idle, no
  guarantee).
- **Android:** ML Kit GenAI APIs (Gemini Nano via AICore) are task-shaped with
  a narrow device list; freeform prompt access was still gated as of early
  2026 — **research needed** before design.

Key consequence of the `.generated`-over-sync design: **mobile doesn't need to
run models to benefit** — it wakes up to a digest the PC produced. Mobile
production is opportunistic gravy; the dependable producers are desktop + the
companion.

## Phases

### Phase 1 — Entity-extraction spike (current)

- New `futo-notes-automations` crate: gline-rs + `gliner_multi-v2.1` int8.
  - Resolve the `ort` pin first: gline-rs pins `2.0.0-rc.9`, workspace is on
    `rc.12`. Worst case, vendor the pre/post-processing (~few hundred lines:
    span decode, subtoken→char mapping) into our own `ort` path — which we'd
    want anyway for mobile.
- Read the real vault read-only, chunk (~300 tokens), extract with a starter
  label set (person, organization, project, place, product/tool, event), write
  `.generated/entities/entities.json` + manifest with content hashes.
- **Verify:** run on Justin's corpus; eyeball precision/recall; tune labels and
  thresholds from real output. Compare NuNER Zero on the same corpus if cheap.

### Phase 2 — Companion skeleton (set-and-forget)

- `setup` TUI: E2EE login → keyring; automation checkboxes → config file;
  installs systemd user timer (cron-line fallback).
- `run` one-shot: sync down → incremental entity pass → write artifacts → exit.
- **Verify:** `systemctl --user list-timers` shows it; unplug for a night,
  artifacts appear by morning; second run is incremental (near-instant on an
  unchanged vault).

### Phase 3 — Structured extraction + good-morning note

- llama.cpp (Vulkan) + NuExtract3 GGUF: per-note schema extraction over
  recently-edited notes.
- Daily digest composed from entity graph + structured pulls →
  `.generated/daily/<date>.md` ("what I'm working on, what's next").
- **Verify:** digest quality on real mornings; measure overnight wall-clock.

### Phase 4 — Distribution + MCP

- Sync carries `.generated/` + config (> the Gap above) → digest on phone,
  settings editable from any client.
- `mcp` subcommand on the shared crates replaces the TS MCP spike; recipes as
  MCP prompts.

## Open questions / risks

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
