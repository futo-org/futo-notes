# Round-trip normalization is acceptable — the editor may re-spell markdown it saves

The editor contract historically required byte fidelity ("diff discipline"): saving changed only
the bytes the user actually touched, and untouched content stayed byte-exact — marker style
(`__` vs `**`, `1)` vs `1.`), whitespace, escapes, CRLF. That requirement was the fixed Tier-3
criterion of the rich-text bake-off (`docs/plan/rich-text-editor-bakeoff.md`) and the stated
reason tree-owned editors (TipTap, Milkdown, Lexical) were
rejected without a probe: parse → tree → serialize re-spells syntax (`- item` → `* item`,
`*em*` → `_em_`) and rewrites the whole file on the first edit. The bake-off's P4 probe proved
the tension is representational, not engineering effort — crossing bold/italic intervals have no
markdown spelling that preserves the original untouched bytes.

**Decided 2026-08-27 (Justin): we accept round-trip normalization.** A tree-owned WYSIWYG editor
(the Milkdown/ProseMirror family — see spike `spike/milkdown-editor`) may re-spell a note's
markdown when saving an edit the user actually made, including normalizing the whole file on the
first edit. Context for the change: sync is moving to CRDTs, so a whole-file rewrite no longer
poisons merges the way markdown-text 3-way merge did, and the WYSIWYG feel is judged worth the
diff/sync churn.

## What still stands

- **Never refuse, never warn, never lose.** Tiers 1 and 2 of the bake-off contract are
  untouched: every markdown file opens editable, no user-facing "your markdown is formatted
  weird" in any wording, and normalization must never DROP or mangle content. Re-spelling
  syntax is accepted; losing constructs the editor's schema doesn't own (raw HTML, wikilinks,
  footnotes, frontmatter) is not, and needs corpus-level proof per candidate.
- **Opening a note never rewrites it.** Only a real user edit may trigger the normalized save;
  browse-and-close leaves the file byte-exact. The Milkdown spike's load-echo guard (compare
  emitted markdown against the serialization of the doc as loaded; hand back the host's original
  bytes until a real edit) is the reference behavior.
- **Exactly one serializer, everywhere.** The churn is paid once only if every platform
  normalizes identically. Two serializers with different spelling preferences ping-pong
  rewrites through sync forever (device A saves `* item`, device B re-spells `- item`, repeat).
  This is AGENTS.md M6 applied to the new model: single-source the schema and serializer — one
  shared editor bundle, or Rust-owned and projected — never per-shell copies.

## Consequences

- The bake-off's Tier-3 "diff discipline" contract and its §4 rejection-without-probe of
  Milkdown/Lexical are **superseded**; do not cite them to block tree-owned editor work. The
  bake-off's measurements (P1's graduate, the corpus censuses) remain valid evidence — this ADR
  changes the requirement, not the data.
- Spec lines that encode byte fidelity as shipped behavior (e.g. `docs/spec/editor.md`
  "adopted text lands verbatim", lazy list numbering preserved on open) still describe the
  shipping CM6 editor and stay in force until an editor built under this ADR actually lands;
  they are then renegotiated with that change, not preemptively.

## Deliberately NOT decided here

Which editor ships; whether mobile eventually gets a native (non-WebView) rewrite; and the CRDT
substrate. The substrate choice is load-bearing: a *text* CRDT over the markdown bytes turns a
whole-file normalization into a delete-and-reinsert that steamrolls concurrent edits from other
devices, while a *tree* CRDT (y-prosemirror family) makes the markdown file a projection and the
churn disappears from sync entirely. That decision must land before a normalizing editor ships.

Origin: Milkdown evaluation discussion (https://milkdown.dev/), 2026-08-27. Prior art:
`docs/plan/rich-text-editor-bakeoff.md`, `docs/plan/p1-zero-visible-syntax.md` (branch
`five-editor-bakeoff`), `docs/plan/editor-decision.md`, spike branch `spike/milkdown-editor`.
