# The editor saves markdown on a debounce; there is no recovery log

Decided 2026-11-02, replacing the 2026-10-29 decision. The text-first editor writes the note's
markdown file 500 ms after the last edit, and at most 2 s after the first unsaved edit while typing
continues: the same rule as the shipping editor. A crash loses at most that window.

The 2026-10-29 version kept a per-note write-ahead log in a hidden vault directory: every edit was
appended before it appeared on screen, flushed to disk within 100 ms, and the markdown was written
only at an explicit checkpoint. That bought about two seconds of typing in a crash. It cost a disk
write on the typing path, a second copy of every open note's text, and about 5,000 lines of
coordination: replacement counters every vault writer had to bump, durable delete intents,
recovery-stream retargeting on rename, and a sync rule that recreated notes a peer deleted. The
benefit did not justify that, so the log was removed before cutover.

What stays from the earlier decision:

- Saving goes through the local note engine's persist-or-park workflow (ADR-0001). A save whose
  base no longer matches disk parks a conflict copy instead of overwriting the other writer.
- A failed save surfaces the failure, keeps the draft in the editor and retries. It does not pause
  input; the existing failed-save and leave rules apply.
- Closing a note saves it. Rename, move, relink and delete coordinate with an attached editor
  inside the store's workflow, so no caller has to remember an ordering.

The per-keystroke page-to-worker handoff was removed on the same day for the same reason: the
portable page now shows each edit at once and streams its requests to the worker without waiting
for replies, and the store takes only the attachment lock for input, not the store gate.

Implementation: `crates/futo-notes-store/src/editor_session/`.
