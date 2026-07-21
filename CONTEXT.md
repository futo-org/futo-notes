# FUTO Notes

Offline-first markdown notes across three apps (desktop, iOS, Android) sharing one Rust local
note engine, with optional E2EE sync. This glossary is the canonical domain language; the
architecture rules live in AGENTS.md, behavior in docs/spec/.

## Language

### Notes and the vault

**Note**:
A markdown file in the vault. The filename IS the title — never transformed, only sanitized.
_Avoid_: document, entry, item

**Vault**:
The on-disk notes root, owned exclusively by the local note engine. Shells never touch it
directly.
_Avoid_: notes folder, library, workspace

**Mutation**:
The engine's authoritative description of one committed change — which notes were upserted,
removed, or renamed, each note's final id, and where each belongs in the sorted list. Shells
apply mutations verbatim; they never derive their own.
_Avoid_: update event, change set, diff

**Projection**:
A shell's read-only note cache, built purely by applying mutations and snapshots. A projection
holds no rules of its own — not sort order, not identity, not collision logic.
_Avoid_: store (for the shell cache), model, optimistic cache

**Final id**:
The id a note actually ends up with after the engine resolves collisions (e.g. "Note" becoming
"Note (2)"). Reported in the mutation; never recomputed by a shell.
_Avoid_: resolved name, actual id

### Drafts and flushing

**Draft**:
The editor's unsaved state for one note: the edited content plus the base it was read from.
_Avoid_: pending changes, dirty buffer

**Base**:
The note content the editor last loaded or saved — what a flush compares against to detect
that the note changed underneath the editor.
_Avoid_: original, snapshot, expected content

**Flush**:
Persisting a draft (on leave, background, or debounce) through the engine's single
draft-saving verb, which resolves every surprise itself and returns one mutation.
_Avoid_: autosave commit, sync save, write-back

**Flush disposition**:
The single outcome of a flush: wrote, converged (disk already matched), recreated (peer
deleted the note; the edit wins at the original id), or parked as a conflict copy. Shells
render dispositions; they never decide them.
_Avoid_: flush result code, save status

**Park**:
Preserving a draft that conflicts with a genuinely different on-disk version as a new conflict
copy — never overwriting the diverged note, never dropping the edit. Idempotent: parking twice
mints one copy.
_Avoid_: backup, stash, save-as

**Conflict copy**:
The note a park creates: "<title> (conflict YYYY-MM-DD)", named by the engine's one
conflict-naming rule.
_Avoid_: duplicate, backup copy, conflict file

**Persist-or-park promise**:
The invariant every shell honors: a draft is never silently lost — it is written, recreated,
or parked. Enforced by the engine, identical on all three platforms.
_Avoid_: no-data-loss guarantee (too vague)

### Sync and the open note

**Open note**:
The note currently loaded in a shell's editor, possibly with a draft in progress. The one
place where sync must negotiate with the user's live typing.
_Avoid_: active document, current file

**Open-note disposition**:
The single verdict on what happens to the open note after a sync or external change: leave it,
adopt, defer-adopt, follow a rename, keep the draft, or close. Decided by one pure classifier
over gathered facts; applied by one executor with a single re-validation.
_Avoid_: reconcile outcome, open-note handling

**Adopt**:
Replacing the open editor's content with the newer on-disk version. Only safe when the editor
is not focused and has no unseen draft.
_Avoid_: reload, refresh, swap-in

**Defer-adopt**:
Remembering a pending adopt while the editor is focused and performing it on the next blur.
_Avoid_: lazy reload, postponed refresh

**Rename intent**:
A rename reported as such by the sync engine at the moment it relocates a note — including
collision placements. Shells follow reported renames; they never infer a rename from id
patterns.
_Avoid_: collision-inferred rename, rename detection
