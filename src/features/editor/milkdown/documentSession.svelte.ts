/*
 * The document an editor holds on the host's behalf: which note it is, the
 * host's own bytes, the load in flight, and whether an edit is still
 * unreported. One instance per editor (MilkdownEditor.svelte). The
 * serialization loop (serializationLoop.ts) and the load path and host handle
 * all read and write it; `loadFailed` and `streamingTail` are `$state` because
 * the component's template reads them.
 */
import type { DocumentRef } from '@futo-notes/editor';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import type { ProgressiveLoad } from './progressiveLoad';

export class DocumentSession {
  /* The markdown the HOST last handed us, kept verbatim while the document is
   * still exactly what it loaded, so an open/close cycle cannot rewrite a note
   * on disk in Milkdown's normalized syntax. */
  hostMarkdown: string | null = null;
  /* The ProseMirror document exactly as it stood after that load. The load echo
   * is decided by comparing DOCUMENTS (`unchangedSinceLoad`), never by
   * serializing: the change notification is debounced by 200ms, so a
   * synchronous "we are applying host content" flag cannot suppress the echo,
   * and the string comparison that used to stand here cost a whole-document
   * serialization on every open and on every `getContent()` of an untouched
   * note (185 ms at 1,000 lines on the low-end Android reference phone). */
  loadedDoc: ProseNode | null = null;
  /* Milkdown's most recent serialization and the document it describes — a
   * cache for `readSerialized()`, so a burst of `getContent()` calls against
   * one document pays once. `liveMarkdown` must NOT start as `''`: an empty
   * string is also a legitimate serialization, so a placeholder `''` made
   * `setContent('')` — a brand-new note — look like content we already held
   * and skip `applyExternal`. */
  liveDoc: ProseNode | null = null;
  liveMarkdown: string | null = null;
  pendingContent: string | null = null;

  /* The in-flight progressive open, if this note was large enough to stream
   * (progressiveLoad.ts). Null the rest of the time, which is every note in an
   * ordinary vault. */
  progressive: ProgressiveLoad | null = null;
  /* Drives the loading affordance over the streaming tail. `$state` because it
   * is read by the template. */
  streamingTail = $state(false);
  unreported = false;
  currentNoteId: string | null = null;
  settlingForFlush = false;
  pendingLoadSource: 'load' | 'external' = 'load';
  /* Whether the last load gave up on chunking mid-flight and reloaded the note
   * whole. Reported by `censusLoad` so the equivalence census cannot score a
   * fallback as proof that a chunked parse matched a whole one — it would be
   * comparing a whole parse against a whole parse. */
  abortedToWholeDocument = false;

  /* CRITICAL — the load THREW and this document is not the note.
   *
   * remark/micromark parse errors are real (a table cell that opens a wikilink
   * token it cannot close was one, fixed in d402d0aa), and the failure mode is
   * silent: `replaceAll` throws, the editor keeps its empty document, and the
   * host sees a blank editable page over a note that has bytes. On 2026-09-03
   * that blank document was then serialized back and written: a 8,635-byte note
   * became 0 bytes on disk.
   *
   * While this is set the component reports the HOST's bytes rather than its
   * own document, emits no change, and refuses edits — the same load-echo
   * contract as an untouched note, extended to the case where the document is
   * not the note at all. Cleared by the next load that succeeds.
   * → docs/spec/editor.md "A note the editor cannot parse" */
  loadFailed = $state(false);

  // Async images and link editing belong to a loaded document, across ordinary edits.
  documentIdentity = 0;
  // Page-monotonic bridge revision: advances on loads, adoptions and user transactions.
  documentGeneration = 0;

  documentRef(): DocumentRef {
    return { noteId: this.currentNoteId ?? '', generation: this.documentGeneration };
  }
}
