## 9. CRDT rebind seam (design constraint now, work later)

Keep everything that feeds markdown strings in/out of the editor behind the engine-wrapper seam
(`MilkdownEditor.svelte` + `createFutoEditorApi`). The CRDT plan
(`docs/plan/crdt-sync-and-sharing.md`) keeps markdown as the editor's input and output and adds
one capability at this seam: applying a remote edit as a small transaction that keeps the caret and
undo history. The prototype of that is `collabApply.ts` on branch `origin/collab-proto`.
