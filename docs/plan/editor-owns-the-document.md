# The editor owns the document — the shells stop reading it

> **Status: IMPLEMENTED 2026-10-03; broad verification exceptions recorded below.** Architecture by Fable with Justin; written as a
> hand-off for an implementing agent. Behavioural truth stays in `docs/spec/editor.md`; §9 lists
> the lines this plan renegotiates. Supersedes nothing — it closes the mechanism that
> issues #194, #244 and #245 are three symptoms of.

- [Implementation journal](editor-owns-the-document/implementation-journal.md)
- [0. Decisions this plan makes (read before starting)](editor-owns-the-document/0-decisions.md)
- [1. The defect, stated once](editor-owns-the-document/1-the-defect-stated-once.md)
- [2. The design — one sentence per rule](editor-owns-the-document/2-the-design.md)
- [3. The bridge contract, v9](editor-owns-the-document/3-the-bridge-contract-v9.md)
- [4. Editor side (`src/features/editor/milkdown/`, `src/editor-embed/`, `packages/editor/`)](editor-owns-the-document/4-editor-side.md)
- [5. The shell mailbox — shared shape, two idioms](editor-owns-the-document/5-shell-mailbox.md)
- [6. Sequencing](editor-owns-the-document/6-sequencing.md)
- [7. Verification chain (report every command and result; M18)](editor-owns-the-document/7-verification-chain.md)
- [8. QA stories (`docs/qa/`)](editor-owns-the-document/8-qa-stories.md)
- [9. Spec renegotiation (`docs/spec/editor.md`)](editor-owns-the-document/9-spec-renegotiation.md)
- [10. Cleanup — the deletion checklist and its proof](editor-owns-the-document/10-cleanup-deletion-checklist.md)
- [11. Traps the agent will meet](editor-owns-the-document/11-traps.md)
- [12. Follow-ups this plan enables but does not do](editor-owns-the-document/12-follow-ups.md)
