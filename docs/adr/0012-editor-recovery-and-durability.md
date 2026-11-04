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

- Saving goes through the local note engine's persist-or-park workflow (ADR-0001). The
  2026-11-03 amendment below permits conservative merging before the conflict-copy fallback.
- A failed save surfaces the failure, keeps the draft in the editor and retries. It does not pause
  input; the existing failed-save and leave rules apply.
- Closing a note saves it. Rename, move, relink and delete coordinate with an attached editor
  inside the store's workflow, so no caller has to remember an ordering.

The per-keystroke page-to-worker handoff was removed on the same day for the same reason: the
portable page now shows each edit at once and streams its requests to the worker without waiting
for replies, and the store takes only the attachment lock for input, not the store gate.

Implementation: `crates/futo-notes-store/src/editor_session/`.

## Amendment: independent edits merge before parking (2026-11-03, #318 / #322)

The native attached editor and the opt-in `flush_draft_merged` workflow attempt a three-way
merge of the saved base, current disk source and local draft under the existing store gate and
vault mutation guard. Clean merges commit exact authoritative source and return the complete
mutation. Ambiguous overlap still parks the local version and leaves the outside version intact.
This changes the previous unconditional parking rule, while retaining ADR-0001's engine ownership
and persist-or-park promise. Debounce and crash durability are unchanged.

Before a native attached merge commits, the editor prepares source/selection correspondence and
rebases both local history stacks. Outside contributions never become a local Undo step. A failed
write does not apply the prepared remote adoption; source/history and saved baseline remain available
for retry (an already settled composition remains a local edit). Ordinary saves leave marked text
provisional; actual outside divergence settles composition before attempted merge adoption, with
coordinated changes reported even if persistence subsequently fails.

The preflight conservatively declines if a historical generation cannot retain exact local patches
and transient syntax metadata, or if its work bound is exceeded; then both versions survive through
parking. Its upper historical generation estimate is current/merged source bytes plus retained patch
bytes: at most 1 MiB, and at most 16 MiB multiplied by retained entry count (at least one). This bounds
repeated full-source reconstruction while holding the attachment lock. The public 20,000-line / 32
isolated-edit regression remains within the budget and retains every Undo step. These are conservative
merge-adoption limits, not note-size or history-retention limits.

Parking is reserved for an unsaved draft. A native session with nothing unsaved (source equals its
saved baseline) whose note changed outside never parks: it adopts the outside source with rebased
history, or, when the preflight declines, drops its Undo/Redo and adopts anyway (as reopening would).
A parked copy of that session would only be the stale baseline.

Legacy `flush_draft` and the portable worker's automatic saves retain their existing contract until
the renderer opts into authoritative adoption. Portable/WASM callers can explicitly adopt a merged
result through `adopt_merged_source` and mirror its normal Append request, preserving page-owned
history without changing the acknowledgement schema. Consumption details:
`docs/architecture/editor-merge-consumption.md`.

## Amendment: independent words within a paragraph (2026-11-03, #323)

The same shared merge owner now retries line-level conflicts at Unicode word boundaries using
`diffy` over lossless interned tokens. This combines independent words without choosing a winner
for overlapping replacements or attempting character-level hybrid spellings. Exact whitespace,
line endings and Unicode source spellings remain authoritative. Same-position insertion ambiguity,
delete/edit overlap and conservative boundary ambiguity retain the conflict-copy fallback. The
Links, URLs and code spans are single tokens, and a side that deletes or replaces one of several repeated words conflicts, because no alignment can say which occurrence was meant. existing native history preflight and portable opt-in adoption contract remain unchanged.

## Amendment: attached drafts follow reported external renames (2026-11-03, #318 / #324)

The external-change projection consumes explicit, committed rename pairs and their final ids under
the store gate and vault guard. It retargets attached sessions while retaining the original saved
baseline, draft, selection, composition and history. Checkpoint then merges or parks at that final
id; a failed save keeps the retargeted draft available for retry. Destination attachment/read failure
leaves identities untouched. Shells apply returned mutations and never infer identity or collision
placement from filename patterns. Portable page requests keep their existing sequence/token contract.
