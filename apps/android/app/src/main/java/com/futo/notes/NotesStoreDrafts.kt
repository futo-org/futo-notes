package com.futo.notes

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import uniffi.futo_notes_ffi.FlushDisposition

/** Fire-and-forget flush for the editor's leave paths (`onDispose` on pop,
 *  and the register's onPause flush): a composable's dispose callback can't
 *  suspend, so the final save runs on the store's scope (which outlives the
 *  screen).
 *
 *  Rust's one `flush_draft` workflow writes, converges, recreates, or parks
 *  the draft under the store's mutation gate. */
fun NotesStore.flushAsync(draft: PendingDraft, ownerToken: Long? = null, onSettled: () -> Unit = {}) {
    if (ownerToken != null && !pendingEditor.owns(ownerToken)) return
    val admission = editorDraftCoordinator.admit(draft.id) ?: return
    val previous = editorDraftTail
    editorDraftTail = scope.launch {
        previous?.join()
        if (!editorDraftCoordinator.permits(admission)) return@launch
        if (flushDraftDirect(draft) != null) { pendingEditor.complete(draft); onSettled() }
    }
}

/**
 * Run an editor's leave commit on the store's scope, which outlives the
 * screen. Back navigates first and commits here after (EditorSession), so
 * the pop never waits on a disk write; [awaitEditorLeaves] is what keeps a
 * note reopened in that window from reading the bytes before the commit.
 */
fun NotesStore.launchEditorLeave(block: suspend () -> Unit): Job {
    val job = scope.launch { block() }
    if (!job.isCompleted) {
        editorLeaves += job
        job.invokeOnCompletion { editorLeaves -= job }
    }
    return job
}

/**
 * Wait for every leave commit still in flight, and every fire-and-forget
 * editor flush queued behind them, before an editor reads its note: the
 * note it opens may be the one just left, its last edit not yet on disk.
 */
suspend fun NotesStore.awaitEditorLeaves() {
    while (true) {
        val pending = editorLeaves.firstOrNull() ?: break
        pending.join()
    }
    editorDraftTail?.join()
}

fun NotesStore.flushRetainedEditor(id: String, content: String, base: () -> String, ownerToken: Long) {
    val previous = editorDraftTail
    scope.launch {
        previous?.join()
        flushAsync(PendingDraft(id, base(), content), ownerToken)
    }
}

/** Persist-or-park one exact editor snapshot through the Rust workflow. */
suspend fun NotesStore.flushDraft(draft: PendingDraft, ownerToken: Long? = null): FlushDisposition? =
    if (ownerToken != null && !pendingEditor.owns(ownerToken)) null else flushDraftDirect(draft)

internal suspend fun NotesStore.flushDraftDirect(draft: PendingDraft): FlushDisposition? = try {
    runMutationTransaction {
        val result = withCore { core.flushDraft(draft.id, draft.base, draft.content) }
        result.mutation?.let {
            applyMutation(it)
            signalLocalChange()
        }
        result.disposition
    }
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    android.util.Log.e("NotesStore", "flush failed for ${draft.id}", e)
    null
}

/** A newly-composed editor claims a register entry; returns its unique token.
 *  Entries are keyed by it, so editors overlapping during the AnimatedContent
 *  cross-fade never evict each other's provider (PKT-1 R2 / PKT-12 G1). */
fun NotesStore.claimDraftOwnership(): Long = pendingEditor.claim()

/** The editor registers its derivation closure under its [token] — evaluated
 *  synchronously at flush time (onPause). Replaces the old hand-synced
 *  set/clear sites: the register reflects the editor's live state on demand. */
fun NotesStore.setDraftProvider(token: Long, provider: () -> PendingDraft?) =
    pendingEditor.setProvider(token, provider)

/** The editor left composition. Its dirty value remains retained until the
 *  asynchronous flush proves it durable. */
fun NotesStore.releaseDraftOwnership(token: Long) = pendingEditor.release(token)

/** The editor registers how to read its LIVE document into its draft, for
 *  [requestPendingEditorFlush]. Released with the draft provider. */
fun NotesStore.setEditorFlushWaiter(token: Long, refresher: suspend () -> Unit) =
    pendingEditor.setFlushWaiter(token, refresher)

/** The notes an open editor holds edits of that are not on disk yet. */
fun NotesStore.unsavedNoteIds(): List<String> = pendingEditor.currentDrafts().map { it.id }.distinct().sorted()

/** Flush the open editor's pending draft to disk if it has unsaved edits.
 *  Called from MainActivity.onPause (the first leave-foreground signal).
 *  Fire-and-forget via [flushAsync], which uses persist-or-park semantics.
 *  Mirrors iOS `flushPendingEditor`.
 *  Best-effort: the write is fire-and-forget, so an immediate process death
 *  can still beat it (same on iOS). */
fun NotesStore.flushPendingEditor() = pendingEditor.flush()

fun NotesStore.requestPendingEditorFlush() {
    scope.launch { pendingEditor.flushAfterEditor() }
}

/** [requestPendingEditorFlush], awaited: each open editor's live document read and
 *  written, then every write queued behind it, so a read of the vault after this
 *  sees the editors' edits. */
suspend fun NotesStore.flushPendingEditorAndWait() {
    pendingEditor.flushAfterEditor()
    awaitEditorLeaves()
}

suspend fun NotesStore.settlePendingEditorDrafts(): Boolean =
    settlePendingDrafts(
        drafts = pendingEditor.currentDrafts(),
        persist = { flushDraft(it) != null },
        onPersisted = pendingEditor::complete,
    )
