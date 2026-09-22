# Sync moves to a tree CRDT (Yjs family) — decided on paper; ships as its own campaign

ADR-0002 accepted round-trip normalization and named the CRDT substrate as the load-bearing open
decision: a *text* CRDT over markdown bytes turns whole-file normalization into
delete-and-reinsert that steamrolls concurrent edits, while a *tree* CRDT makes the markdown file
a projection and the churn disappears from sync entirely.

**Decided 2026-08-28 (Justin): the substrate is a tree CRDT, Yjs family.** Concretely:
`y-prosemirror` (via `@milkdown/plugin-collab`) binds the editor document; `yrs` — the Rust port,
wire-compatible with Yjs — owns the Ydoc in the store when the sync campaign lands, keeping the
Rust-owns-the-domain rule (M6) intact instead of moving document truth into JS. The markdown file
on disk becomes a projection of the Ydoc, which preserves the file-over-app promise for reading
and external tooling.

## Sequencing (decided with it)

The **editor ships first, on the existing file-based E2EE sync** (Milkdown transition — see
`docs/plan/milkdown-transition.md`). Normalize-once churn under text-based 3-way merge is accepted
as a bounded, self-extinguishing cost: each note rewrites at most once on its first real edit,
one serializer everywhere prevents ping-pong, and the conflict-copy machinery catches the rare
concurrent-edit collision during the window. CRDT sync is a separate later campaign; the editor's
engine wrapper is built so the rebind from markdown-string content plumbing to a y-prosemirror
Ydoc binding happens at that one seam.

## Named obligations of the future CRDT campaign (not this editor release)

- **External file edits** (vim, scripts, other apps) cannot be expressed as tree deltas; they must
  be re-parsed and tree-diffed into the Ydoc on file-watcher events, degrading that one edit to
  replace-like semantics. This is the tax of the tree choice and needs explicit design.
- Server protocol: encrypted Yjs updates as the opaque blobs the server already expects
  (update-log or merged-state semantics to be designed).
- Vault/history migration, and the fate of the 3-way merge + conflict-copy + ancestry machinery in
  `futo-notes-core`/`-sync`, which CRDT merge replaces.
- Prior art to read first: branch `origin/collab-spike`, checkout
  `~/Developer/stonefruit-collab-spike`.

Origin: Milkdown transition decision session, 2026-08-27/28. Context: ADR-0002,
`docs/plan/milkdown-transition.md`.
