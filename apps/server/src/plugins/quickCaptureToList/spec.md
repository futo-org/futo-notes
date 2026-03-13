# Quick Capture To List Spec

Default apply mode: auto-apply.

1. Scan `Untitled` notes oldest-first so older quick captures get resolved first.
2. Read the note text and ask the LLM to choose the best existing list note.
3. If there is no good match, route the capture into the `Inbox` list instead.
4. The proposed change is a move, not a copy: once approved/applied, the destination list gains the inserted list item(s) and the source `Untitled` note is deleted.
5. Multiple `Untitled` notes in the same run are handled independently; every note that produces a merge proposal is expected to be deleted after that proposal is applied.
