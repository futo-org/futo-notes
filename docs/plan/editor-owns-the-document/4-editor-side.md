## 4. Editor side (`src/features/editor/milkdown/`, `src/editor-embed/`, `packages/editor/`)

### 4.1 Where the counter lives

`MilkdownEditor.svelte` already has `documentGeneration` (`:415-429`, ticked by `openNote` and
teardown, used for image targeting). Promote it: it becomes THE generation, ticked also by
`applyExternal` success and by every reportable transaction. Keep the image-insert use; it
benefits (a late insert can be refused by generation — out of scope, note it as a follow-up).

Add component state `currentNoteId: string | null` set by `openNote(noteId, text)` /
`setContent` and cleared on teardown. The component's public callbacks become:

- `onchange(content, ref: DocumentRef, flushToken?: string)` — desktop ignores the extras.
- `onedited(ref)` — new.
- `ondocumentloaded(ref, source)` — new.
- `onflushfailed(ref, token, reason)` — new.
- `onexternalrefused(ref)` — new.
- `flush(token?)` — new method (also used internally by the self-flush edges with no token).

### 4.2 `edited`: a transition flag in the plugin's callback

`documentChanges.ts` `createDocumentChangePlugin` already calls `onDocumentChanged()`
synchronously at dispatch. In the component's `documentEdited` (`:1040-1043`): increment the
generation, and if `unreported === false` set it and post `edited`. `unreported` is cleared
when a `change` for the current generation is posted or a load replaces the document. Do not
post `edited` per keystroke: it is a transition. The existing `editedDuringLoad` flag merges
into this (it is the same fact restricted to the streaming window).

### 4.3 A load flushes the outgoing document first

`applyExternal` (`:1416-1529`) today never cancels or flushes `changeTimer`, and `holdsExactly`
(`:1643-1674`) is deliberately side-effect free because an untagged `change` from there would
land in the next note (RC-04). Both reasons die with tagging. New order at the top of a load
for a DIFFERENT note id (`setContent`/`openNote`):

1. If the outgoing document has an unreported edit: if it is streaming, `endPendingLoad('settle')`;
   then post `change` tagged with the OUTGOING ref. Synchronously, before anything about the
   new note is touched. (A streaming, unedited outgoing document is discarded as today.)
2. Proceed with the load; post `documentLoaded` for the new ref once the whole document or the
   first chunk is in the view.

A load for the SAME note id (the host re-pushing, `holdsExactly` true) still posts nothing.

This is what makes the iOS wikilink pop structurally safe: UIKit re-adopts the parent and pushes
`setContent(parent)` before the child's exit runs; the child's pending edit goes out tagged with
the child's id in step 1; the child's `finishLeave` then finds its mailbox current and commits
with no WebView interaction (`docs/qa/wikilink-pop-large-edited-note.md` is the acceptance
story). Cost to name in the comment: a streaming AND edited outgoing note is settled
synchronously here, bounded by its parse, which is the same bound today's capture had.

### 4.4 `flush` and the self-flush edges

`flush(token)` is `captureContent()` (`:1676-1697`) turned inside out — same steps, but the
answer is posted, not returned:

1. `loadFailed` → `flushFailed(reason: 'loadFailed')`. No document / never loaded →
   `flushFailed(reason: 'noDocument')`.
2. Streaming and edited → `endPendingLoad('settle')` (forces the tail; the host asked).
   Streaming and clean → serialize is the echo (`hostMarkdown`), cheap.
3. Cancel the debounce timer, stop a pending priming wait, `readSerialized()`; `null` →
   `flushFailed(reason: 'serializer')` (RC-17's fallback to older text is gone — the host has
   that text already).
4. Post `change` with the current ref and `flushToken`. Clear `unreported`.

A flush when nothing is unreported still posts `change` (the host dedupes by generation). It
costs one cached serialization; for an unedited document it is the host's own bytes.

Self-flush (no token) on: the editor's own blur (`:689-690` focus listeners → add the call
before `onfocuschange(false)`), `document.visibilitychange` → `hidden`, and `pagehide`. These
are defence in depth; the shells' explicit `flush` on exit/background is the primary path,
because Android's WebView does not reliably see `visibilitychange` when the Activity pauses.

Delete `captureContent()`, `editReadOutOf` and the RC-28 arming at `:1757` — RC-28 existed
because a host read handed out text before any `change` said so; nothing is handed out any
more. Keep `getContent()`/`readContent()` on the component for desktop (`NotesShell.svelte:80`,
`createNotePersistence.ts:64`, `createNoteLoader.ts:72-91`); remove the `window.FutoEditor.getContent`
wiring in `createFutoEditorApi.ts:125-140` (the RC-73 `?? ''` coercion goes with it).

### 4.5 Conditional external apply

`applyExternalContent(noteId, markdown, expectedGeneration)`: if `currentNoteId !== noteId` or
`generation !== expectedGeneration` or `unreported` → post `externalRefused` with the current
ref and do nothing else. Otherwise apply exactly as today (`setContent` path →
`applyExternal`, history-suppressed), increment the generation, post `documentLoaded(source:
'external')`. The `adoptIfUnchangedScript` compare-and-swap (RC-70/71) is this, expressed by
generation instead of by text, and it closes the "keystroke between read and replace" window
by construction: a keystroke bumps the generation, the apply is refused, the shell already has
the `edited` watermark and rebases again.

### 4.6 Embed wiring (`src/editor-embed/main.ts`, `createFutoEditorApi.ts`, `hostBoot.ts`)

- `main.ts:82-88` `onchange` currently ignores its argument and re-reads `getContent()`. It now
  posts what the component handed it, with the ref and token.
- Wire the four new callbacks to posts.
- `hostBoot.ts` applies `config.noteId` before `content` (step order at `:182-203`), and
  `createFutoEditorApi.setContent` passes the id through.
- `createFutoEditorApi.initialize`/`setContent` keep `resetHistory()`.

### 4.7 Editor-side tests

Playwright (`tests/editor-embed-milkdown.spec.ts`; helper `settleChangeDebounce` at `:78-86`):

- Rewrite: `:293` (the `change` carries `noteId`/`generation`), `:840/:863/:877` (switch
  semantics: the outgoing note's change is posted tagged BEFORE the next note loads; nothing
  for the outgoing note arrives after), `:904` (**inverted**: a switch inside the debounce posts
  the typed text tagged with the outgoing id, then shows the next note), `:2660/:2774`
  (`flush` mid-stream: clean → echo with load generation; edited → settles and posts the full
  note), `:2976/:3003` (a `flush` reports the unreported edit exactly once).
- Add: `edited` is posted once per unreported run, synchronously, including during streaming;
  `flush(token)` echoes the token; `flushFailed` on a serializer throw (reuse the throwing
  fixture from `MilkdownEditor.test.ts:196-253`) and on a never-loaded page; `applyExternalContent`
  with a stale generation posts `externalRefused` and leaves the text alone; with the right
  generation posts `documentLoaded(external)`; `documentLoaded` after `initialize`, after
  `setContent`, and after the first chunk of a streamed load; blur/visibilitychange/pagehide
  each post a `change` immediately; a `change` is never posted for a note id the editor no
  longer holds.
- `packages/editor/src/bridge.test.ts`: version 9, the method list without `getContent` and
  with `flush`, the union with the new shapes.
- `packages/editor/src/hostBoot.test.ts`: `noteId` required and applied before content.
- `tests/note-never-emptied.spec.ts:410` (RC-28) — rewrite as: an Undo back to the loaded
  document after a flush is still reported (the flush cleared `unreported`; the undo is a new
  reportable transaction, so it is).
- `src/features/editor/milkdown/documentChanges.test.ts`: unchanged; add the transition test
  for `edited` wherever the flag lands (component test).

Desktop must be untouched in behaviour: `just check` and the desktop Playwright suite green with
no desktop code change beyond passing `noteId` into `openNote`.
