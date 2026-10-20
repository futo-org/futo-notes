## 2. Evidence base (do not re-derive)

- **Perf probe 2026-08-27** (standalone, @milkdown/kit 7.22.1, headless Chromium): passes open <1 s
  + keystroke p95 <16 ms through 14k lines *with* `.ProseMirror > * { content-visibility: auto;
  contain-intrinsic-size: auto 24px }`; ceiling ~16k lines, bound by remark parse (~62 ms/1k lines,
  linear — no TipTap-style wall). Keystroke cost without the cv rule is 82% browser layout over the
  eager whole-doc DOM. Typing passes even at 50k with cv (+ filtering the preset's two whole-doc
  per-transaction walkers, not needed ≤16k). Numbers are from a fast desktop — low-end Android
  multiplies them, which is why D7 exists.
- **Round-trip corpus census** (the spike's corpus report; its numbers are reproduced in
  `docs/editor/milkdown-roundtrip-census.md`): 31k notes,
  zero crashes/hangs. Two real loss classes — inline `<br>` deleted (word fusion; the standard
  multi-line table-cell idiom) and `[](url)` links deleted href-and-all — plus one corruption class
  (spurious `<br />` on `* 0.`-style bullets). All three root-caused in the spike's
  round-trip findings, fixes ~90% done as string guards (parked). §3 below replaces the
  string-guard approach.
- **Note-size population**: foreign corpus max 19,295 lines (2 notes >10k of 30,995); Justin's
  vault max 13,876 lines (next largest 978, of 2,511).
- Spike already has: `MilkdownEditor.svelte` mounted through the shared embed, bridge extensions in
  both native shells, native toolbar format-state highlighting, Notion-style block drag with
  real-device hardening, native image paste, and the load-echo guard (ADR-0002's reference
  behavior).
