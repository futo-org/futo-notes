# iOS 27 / macOS 27 Apple Intelligence — Research Notes

> Captured 2026-06-19, ~10 days after the WWDC26 keynote (2026-06-08).
> Everything below reflects **developer beta 1**. Specs and behavior will shift
> through the beta cycle; re-verify against Apple docs before relying on a number.
> Public release expected ~September 2026.

## TL;DR

- iOS 26's on-device model was a **~3B dense** model — the "small / lacking" one.
- iOS 27 ships **AFM 3** ("third generation"), with **two** on-device tiers:
  - **AFM 3 Core** — the successor to the 3B dense model (still ~3B).
  - **AFM 3 Core Advanced** — a **20B-parameter sparse MoE** that activates only
    **1–4B params per request**. This is the real step up and the one to target.
- Built **in collaboration with Google (Gemini)** — confirmed by Apple ML Research
  and TechCrunch; conspicuously absent from Apple's marketing newsroom post.
- You can run AFM 3 **on the Mac** via the new pre-installed **`fm` CLI** + a
  **Python SDK** (`apple_fm_sdk`) in **macOS 27 "Golden Gate"** — no phone needed
  for prompt/schema/tool-calling iteration.
- **Caveat:** which on-device *tier* runs is hardware-dependent and not selectable;
  a Mac likely runs the bigger 20B variant than a given iPhone tier → Mac testing
  can be **optimistic** vs the phone.

## The on-device model (AFM 3)

| | iOS 26 | iOS 27 |
|---|---|---|
| On-device model | ~3B dense | **AFM 3 Core** (~3B dense) **+ AFM 3 Core Advanced** (20B sparse) |
| Active params (Advanced) | — | 1–4B per request |
| Architecture (Advanced) | — | Sparse MoE via **Instruction-Following Pruning (IFP)** |
| Weight storage (Advanced) | DRAM | Full 20B in **flash/NAND**; "shared experts" always-active, "routed experts" swapped into DRAM on demand |
| Quantization | — | **Quantization-Aware Training (QAT)** |
| Languages | fewer | ~25 locales |

- Published quality datapoint: on dictation, **AFM 3 Core Advanced preferred
  44.7% vs 17.6%** over the prior system.
- **Unconfirmed / rumor only** (low-credibility sources — do NOT trust without
  testing): "32k+ token context window", "1.2T-param Gemini teacher model",
  exact context limits. Apple has not published these.

## Device requirements

- **Apple Intelligence / on-device model:** iPhone 15 Pro / iPhone 16-and-later,
  iPad mini (A17 Pro), iPad with M1+, Mac with M1+.
- The "works back to iPhone 11" claims refer to **installing iOS 27**, NOT running
  the on-device model. Don't conflate the two.

## Running Foundation Models on the Mac (the `fm` CLI)

New in **macOS 27 ("Golden Gate")**, pre-installed (ships with the OS, not Xcode).
WWDC26 session 334. There's also a Python SDK (`apple_fm_sdk`) mirroring the Swift
Foundation Models API (tool calling, guided generation, streaming).

```bash
fm respond "summarize this note"          # single-turn
fm chat                                    # interactive REPL
fm schema object --name Digest --string title --array app_names > schema.json
fm respond "..." --schema schema.json      # guided / structured output
fm respond "..." --image shot.png          # multimodal input
fm respond "..." --model pcc               # use Private Cloud Compute (big server model, usage-limited)
fm serve                                   # local OpenAI-compatible Chat Completions server
```

- Default = on-device AFM 3 (no API key, no cloud cost, no usage limit).
- `--model pcc` = Private Cloud Compute server model (bigger, better on complex
  tasks, usage-limited).
- **`fm serve`** exposes an OpenAI-compatible local endpoint → drop-in backend for
  the briefing/digest harness + GEPA loops (replaces the Ollama-3B proxy and is
  cleaner than the swiftc CLI harness). See the FoundationModels / briefing-harness
  memory notes.

### Important caveat — "same model as the iPhone?"

- Apple only exposes **on-device vs PCC** — you **cannot** pick 3B Core vs 20B
  Advanced. Which on-device tier runs is **hardware-dependent**.
- A Mac with ample RAM/Apple Silicon likely runs the **20B Advanced** tier, while a
  target iPhone may run **3B Core**. So Mac output can be **optimistic** vs the phone
  (opposite of the usual "simulator is weaker" problem).
- Same model family / tokenizer / guardrails / structured-output behavior → great
  for iterating prompts, schemas, tool-calling. **Still do a device pass** before
  trusting quality / fabrication metrics.

## Developer setup & upgrade path

- **Xcode 27 beta requires macOS Tahoe 26.4+.** Apple Silicon **only** — Intel Macs
  are dropped this cycle (macOS 27 has no Intel support).
- **`fm` and the AFM 3 model require the macOS 27 beta itself** (bigger commitment
  than just Xcode). Apple Intelligence must be **enabled** (this Mac currently has it
  off — see mac-testing-environment memory).
- **iOS 26 development is unaffected:** Xcode 27 supports deployment targets
  **iOS 15 → 27**. You can keep shipping iOS 26 (and older) builds. The "April 2026
  SDK rule" is about the minimum *build* SDK for App Store submission, NOT the OS
  versions you may target. Keep Xcode 26 side-by-side via `xcodes` only if you need
  the old *SDK*.

### Beta state & risk (as of beta 1)

- Beta 1 is the roughest point. Direction is well-received (Liquid Glass walkbacks,
  better perf) but expect bugs: third-party menu-bar/utility breakage (e.g. Ice),
  networking/install hiccups, firmware-update gaps until beta 2, >2GiB binary launch
  failures, VM-install bug if coming from older Tahoe.
- Apple Silicon **downgrade is painful** (full DFU restore + backup).
- **Recommended:** install macOS 27 on a **separate APFS volume / external SSD /
  spare Mac**, back up first. Boot-pick between stable macOS (keeps shipping iOS 26)
  and the beta (AFM 3 sandbox). Promote to main volume only after ~beta 3 / public
  beta once key third-party tools update.

## Recommended workflow for FUTO Notes briefing/digest work

1. macOS 27 beta on a separate APFS volume → `fm serve` (or Python SDK) as an
   OpenAI-compatible AFM 3 backend for the briefing harness + GEPA loops.
2. Lock down prompts, `@Generable`/JSON schemas, and tool-calling on the Mac
   (behavior carries across).
3. Final **quality pass on a loaner device** (request one — single daily-driver phone
   shouldn't take early betas) to catch the 20B-Mac-vs-3B-phone gap before believing
   fabrication/quality numbers.

## Sources

- [Apple ML Research — Introducing the Third Generation of Apple's Foundation Models](https://machinelearning.apple.com/research/introducing-third-generation-of-apple-foundation-models)
- [Apple Newsroom — Next generation of Apple Intelligence, Siri AI, and more](https://www.apple.com/newsroom/2026/06/apple-unveils-next-generation-of-apple-intelligence-siri-ai-and-more/)
- [TechCrunch — WWDC 2026: everything announced (Gemini collaboration confirmed)](https://techcrunch.com/2026/06/09/wwdc-2026-everything-announced-on-siri-ai-os-27-apple-intelligence-and-more/)
- [Apple Developer — WWDC26 session 334: the fm CLI and Python SDK](https://developer.apple.com/videos/play/wwdc2026/334/)
- [macOS Golden Gate 27 Beta Release Notes — Apple Developer](https://developer.apple.com/documentation/macos-release-notes/macos-27-release-notes)
- [Foundation Models from Python: the fm CLI — Blake Crosley](https://blakecrosley.com/blog/foundation-models-python-fm-cli)
- ["Supported Deployment Target Versions is 15.0 to 27.0" in Xcode 27 — BleepingSwift](https://bleepingswift.com/blog/deployment-target-supported-range-xcode-27)
- [Don't panic about Apple's April 2026 SDK rule — Medium](https://medium.com/@dhavaljasoliya8/ios-developers-dont-panic-about-apple-s-april-2026-sdk-rule-here-s-the-truth-9a0fdbc91242)
