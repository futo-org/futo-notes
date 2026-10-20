## 4. The candidates

Five approaches. Each entry states the document model, why it can satisfy the
contract, what exists already, and the kill condition its probe targets.
Approach 1 is the incumbent evolution and fully reversible; the burden of
proof rises with distance from the shipping stack.

### Approach 1 — CM6 + intent compiler on source

Markdown text stays the only document. Add a semantic command layer: a CM6
transaction filter that recognizes edits which would break a construct
(Enter/Backspace/paste across an inline mark, wikilink, code span) and
rewrites the transaction into well-formed source before it lands. Pair with
marker auto-heal (typing inside a bold span keeps the span; deleting one `*`
of a pair removes both).

- **Contract:** tiers 1–3 hold by construction — source is never serialized.
  The open question is purely presentation quality.
- **Exists already:** the whole markdown-spec fixture system, the factory
  judge, `packages/editor` hot-path rules. Smallest delta from today; works
  in all three shells unchanged.
- **Kill condition:** whack-a-mole. If passing the split-torture matrix
  requires N bespoke rules with no shared mechanism (rule count grows
  linearly in constructs × operations), the approach does not scale.
  Secondary ceiling: markers still reveal near the caret — decorated source
  may never read as "rich text" to the target user.

### Approach 2 — Block-projectional hybrid: rendered blocks, one live edit region

The document is the source string plus a block map (reuse the sidecar's map
from `codex/tiptap-desktop`, minus ProseMirror). Inactive blocks render as
pure HTML projections of the token stream — never re-serialized, so arbitrary
syntax survives untouched by construction. The block under the caret mounts a
real editor (a per-block CM6 instance) over that block's source slice. Where
the block map cannot be built, that block quietly edits as source — per-block,
no banner. The Typora/Bear family, with the file kept authoritative.

- **Contract:** serialization never happens anywhere; worst case for exotic
  markdown is "this one block edits as source," which is tier-1/2 clean.
- **Exists already:** the block map, the live-preview render pipeline, CM6.
- **Kill condition:** feel at the seams. Caret crossing a block boundary
  flips modes; a flicker or a 1-pixel layout shift reads as broken.
  Cross-block selection/drag and IME composition across a boundary are the
  known-hard parts — test them first, not last.

### Approach 3 — TipTap fail-open: verbatim islands

Keep the `codex/tiptap-desktop` architecture but invert every failure. A
block the model cannot own becomes an atomic verbatim node: rendered as a
faithful preview, byte-exact on save, tap-to-edit via an inline source
micro-field. A note whose block map fails degrades per-block instead of the
current whole-note `exact-only` mode. The reparse-and-compare guard stays,
but a refusal converts the block to a verbatim island instead of blocking the
save. Separately: fix serializer escaping upstream to push the 18.94%
edited-block rewrite rate toward 0, and prototype block-local incremental
lexing against the super-linear open.

- **Contract:** tiers 1–2 become satisfiable. Tier 3 is structural risk: as
  long as saving means "serialize the semantic tree for the edited block,"
  some rewrites are inherent.
- **Exists already:** most of it — sidecar, anchors, recovery machinery, two
  test suites, a census harness.
- **Kill condition:** the residual silent-rewrite rate after serializer fixes
  stays material on the common-construct set, or block-local incremental
  lexing proves impossible while the sidecar requires the whole token stream.

### Approach 4 — TipTap as pure renderer, source as document (transaction→patch mapping)

Never serialize TipTap at all. The rich document is a _view_; every
ProseMirror transaction (insert text, split node, toggle mark) is mapped at
input time into an exact source patch via a bidirectional position map
maintained per block down to inline level. The user edits TipTap's mature
surface — selection, IME, history, tables — but the file is only ever
modified the way CM6 modifies it: by text patches.

- **Contract:** all three tiers hold _if the mapping is total_, because
  markdown is never regenerated from the tree.
- **Exists already:** the block-level half of the map (the sidecar); the
  inline-level half does not exist and is the hardest code in this space.
- **Kill condition:** any transaction class whose source patch is ambiguous
  (e.g. "lift list item" in a list mixing task and plain items). One
  ambiguous class found by the fuzzer is the kill signal — do not rationalize
  it away with a normalization fallback, because that fallback IS Approach 3.

### Approach 5 — Rust engine, rehosted: projectional editing over source, everywhere

`crates/futo-notes-editor` already is a source-owned projectional editor with
region-scoped reveal and a proven widget model (see §3). Two hosting
variants: (a) the parked native renderers (TextKit 2 / EditText / gpui);
(b) **compile the engine to wasm and let it drive a DOM renderer inside the
existing WebViews** — one engine on all three platforms without the gpui bet,
and it satisfies the Rust-owns-the-domain rule (M6) instead of straining it.
The probe below targets only variant (b); variant (a) is the parked
editor-decision and is out of scope here.

- **Contract:** same reason as 1 and 2 — source truth, projection rendering —
  with the projection written once in Rust.
- **Exists already:** the engine, 268/268 fixtures, both mobile widget
  spikes, the interaction-judge harness.
- **Kill condition:** keystroke latency through the wasm boundary, or IME
  composition correctness in the WebView DOM surface. Scope honesty: even a
  green probe leaves the parked ship-gates (widgets-on 10k perf, keyboard
  matrix, a11y) as the real bar.

### Rejected without a probe: buy an existing library

Surveyed once, recorded so it isn't re-litigated: Milkdown and Lexical are
tree-owned (same class as TipTap, same tier-3 problem). Typora and Obsidian's
live preview are closed source. MarkText/Zettlr are the block-hybrid family
but effectively unmaintained. There is no maintained, source-owned, rich
markdown editor to buy. A half-day re-verification of this claim is permitted
before probes start; anything longer is waste.
