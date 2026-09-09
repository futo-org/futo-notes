# Editor strategy — parked native transition

The native-editor transition was deferred by Justin on 2026-07-17. On this `main`
baseline, all three apps still ship the shared CM6/webview editor. The Rust editor
engine, gpui desktop app, and native renderer experiments remain on their branches.
The earlier July 13 provisional choice of native mobile did not complete its ship gates.

On 2026-08-27 Justin accepted round-trip normalization; see
`docs/adr/0002-roundtrip-normalization-accepted.md`. That supersedes the earlier
byte-fidelity restriction and reopens tree-owned editors such as Milkdown/ProseMirror.
Never-refuse / never-warn / never-lose and one serializer everywhere still bind.
The five-approach results and remaining experiments live in
`docs/plan/rich-text-editor-bakeoff.md`.

## If the native transition resumes

Reconcile the parked Rust engine against the current markdown-spec corpus first.
The July transition rule (Rust engine + fixtures first, CM6 port in the same MR)
is suspended while the transition is parked; it does not replace the ordinary
canonical Rust / conformance-locked TS rules in `AGENTS.md`.

The following gates were left unfinished. They remain prerequisites for replacing
a platform's webview with the parked native renderer, not claims of current coverage.


1. **Widgets-ON large-note perf (the gap the campaign left).** Every 10k perf
   number so far was measured with widgets off: iOS ran under the >2k-line
   raw-marker fallback, Android's E1 adapter rendered checkboxes/bullets as
   raw source, and the one widgets-on-at-scale datum is the pre-fix iOS
   1.56s/keystroke disaster. Implement viewport-scoped widget rendering on
   both platforms (lifts the iOS >2k fallback; fixes Android's failed scroll
   gate in the same stroke — checkboxes/bullets as per-line spans on Android,
   viewport-bounded attachments on iOS), then RE-RUN the 10k A/B with
   checkboxes, bullets, tables, and images actually rendering. Gates:
   open ≤1s, typing p95 ≤2× CM6, scroll hitch ≤2% — same thresholds as P0-3.
2. **Live-keyboard matrix.** Android: GBoard + FUTO Keyboard + one OEM —
   composition w/ candidate bar, swipe, autocorrect at marker boundaries
   (the least-derisked item left anywhere). iOS: the waived physical
   rechecks — fresh-note dictation, 10s scroll run, VoiceOver reading order
   + checkbox toggle.
3. **Device a11y pass** (VoiceOver / TalkBack) using the engine-derived
   reading tree — treat as a blocker, not a launch-day surprise.
4. **Feature parity vs docs/spec/editor.md** — toolbar exec map, wikilink
   autocomplete, image paste, link follow — checked per platform, plus the
   layer-2 conformance harness green on device (already standing).


## Historical evidence

The original criteria, device measurements, experiment branches, provisional verdict,
and deferral are preserved in Git:

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/plan/editor-decision.md
```
