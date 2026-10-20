## 12. Follow-ups this plan enables but does not do

- `insertImage` refused by generation (the #194 sibling at `milkdown-transition.md` §10).
- Android Gap #80: quarantine-after-latch is one more mailbox field.
- Desktop could adopt the same `edited`/generation signals for `hasUnseenEditorChanges` and
  `closeDeadlineDirty.ts` instead of reading the component; not needed for correctness there.
- Step two (Rust owns the live document) is a separate decision; whichever tree store is
  chosen, the per-note mailbox is the seam it plugs into.
