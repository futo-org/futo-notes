package com.futo.notes

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

/** An open editor's unsaved draft: the note [id] to persist, the [content] to
 *  write, and [base] — the content the editor believes is on disk (its
 *  savedContent). [base] is the expected-previous for the conditional flush
 *  (see [NotesStore.flushAsync] → `flush_draft`): the flush writes only
 *  if the note still holds [base], so a note deleted or sync-adopted while
 *  backgrounded is neither resurrected nor clobbered. Mirrors the iOS
 *  `pendingDraft` tuple. */
data class PendingDraft(val id: String, val base: String, val content: String)

internal suspend fun settlePendingDrafts(
    drafts: List<PendingDraft>,
    persist: suspend (PendingDraft) -> Boolean,
    onPersisted: (PendingDraft) -> Unit,
): Boolean {
    var allPersisted = true
    for (draft in drafts) {
        if (persist(draft)) onPersisted(draft) else allPersisted = false
    }
    return allPersisted
}

/** The open editor's unsaved-draft derivation — the ONE definition of "is there
 *  an unsaved draft, for which note" (PKT-12 R5). Returns a draft keyed on the
 *  LIVE [noteId] (so it re-keys by construction after a rename) whenever the body
 *  has loaded and diverges from what's on disk; null when clean or not yet
 *  loaded. [savedContent] is both the dirty check and the flush's expected-prev
 *  [base]. Pulled synchronously at flush time by [PendingEditorDraft]. Pure +
 *  top-level so it is unit-testable without composition. */
internal fun derivePendingDraft(
    loaded: Boolean,
    noteId: String,
    savedContent: String,
    content: String,
): PendingDraft? =
    if (loaded && content != savedContent) PendingDraft(noteId, savedContent, content) else null

/**
 * The open editor's unsaved-draft register and its leave-foreground flush,
 * factored out of [NotesStore]/Compose so the F8 jetsam-guard decision is
 * unit-testable — apps/android ships JUnit only (no Robolectric/coroutines-test),
 * so the FFI-backed [NotesStore] can't be constructed in a JVM test.
 *
 * The register is DERIVED and PULL-based: each open editor registers ONE
 * derivation closure (`{ if (loaded && content != savedContent) draft else null }`)
 * via [setProvider]; [flush] invokes them SYNCHRONOUSLY at the leave-foreground
 * edge to read each editor's live state (PKT-12 R5). One source of truth instead
 * of ~7 imperative set/clear sites that raced the editor (PKT-1 R1-R4). Pulling
 * at flush time (rather than an async snapshotFlow that pushes updates) closes
 * the publication-window gap: an edit landing immediately before onPause is
 * always seen, because the provider reads the current snapshot state when the
 * flush runs, not whenever a conflated async collector last happened to fire.
 *
 * The register is a MAP of generation-token → provider, NOT a single slot. During
 * the AnimatedContent cross-fade the incoming editor composes (and registers its
 * provider) before the outgoing one disposes, so both are briefly live. A single
 * slot would let the incoming editor's registration EVICT the outgoing (still
 * dirty) editor's provider — and since the incoming editor is unloaded it derives
 * null, so a pause+kill before the outgoing's dispose would flush nothing and
 * lose its edit (PKT-1 R2 / PKT-12 G1). Keeping every live provider and flushing
 * ALL of them (at most two during a cross-fade) kills that eviction by
 * construction; [release] removes only the caller's own entry.
 *
 * MainActivity.onPause calls [flush] at the FIRST leave-foreground signal.
 * Idempotent, and a no-op when every open editor is clean / closed. Mirrors iOS
 * `NotesStore.pendingDraft` + `flushPendingEditor` [editor.md].
 */
/** Bound the system-background mailbox wait before flushing the last known draft. */
internal const val EDITOR_FLUSH_BUDGET_MS = 2_000L

internal class PendingEditorDraft(private val persist: (draft: PendingDraft) -> Unit) {
    private var seq: Long = 0
    private var retiredThrough = 0L
    fun reset() { retiredThrough = seq; providers.clear(); retained.clear(); flushWaiters.clear() }
    fun owns(token: Long): Boolean = token > retiredThrough && token <= seq
    private val providers = LinkedHashMap<Long, () -> PendingDraft?>()
    private val flushWaiters = LinkedHashMap<Long, suspend () -> Unit>()
    private val retained = LinkedHashMap<Long, PendingDraft>()

    /** A newly-composed editor claims an entry; returns its unique generation
     *  token (the map key). Registration/removal are keyed by it, so editors
     *  overlapping during a cross-fade never touch each other's entry. */
    fun claim(): Long = ++seq

    /** The editor registers (or re-registers) its derivation closure under its
     *  own [token]. Never evicts another editor's entry. */
    fun setProvider(token: Long, provider: () -> PendingDraft?) {
        if (token > retiredThrough) providers[token] = provider
    }

    /** The editor left composition. Keep its last dirty value until a storage
     *  operation proves that exact draft durable. */
    fun release(token: Long) {
        flushWaiters.remove(token)
        providers.remove(token)?.invoke()?.let { retained[token] = it }
    }

    fun complete(draft: PendingDraft) {
        retained.entries.removeAll { it.value == draft }
    }

    /** Snapshot retained drafts present when an ordinary save starts. */
    fun retainedSnapshot(id: String): Map<Long, PendingDraft> =
        retained.filterValues { it.id == id }

    /** Clear only snapshots that are still the admitted values. */
    fun completeSnapshot(snapshot: Map<Long, PendingDraft>) {
        snapshot.forEach { (token, draft) ->
            if (retained[token] == draft) retained.remove(token)
        }
    }

    fun discardNote(id: String) {
        retained.entries.removeAll { it.value.id == id }
        providers.entries.removeAll { it.value()?.id == id }
    }

    fun retargetRetainedNote(oldId: String, finalId: String) {
        retained.replaceAll { _, draft ->
            if (draft.id == oldId) draft.copy(id = finalId) else draft
        }
    }

    /** Persist the latest posted drafts by pulling each provider synchronously.
     *  The lifecycle caller awaits mailboxes before this write. Flushes all live
     *  providers — at most two during a cross-fade — so an outgoing dirty editor
     *  is never dropped. No-op when every provider derives clean / closed; safe to
     *  call at every leave-foreground signal.
     *
     *  Derivations are COALESCED by note id before dispatching, so two editors
     *  overlapping on the SAME note during a cross-fade (e.g. rename + self-link
     *  navigation, both dirty) never fire two conditional writes that read the
     *  same base and race — exactly one flush per note. The winner is the
     *  LAST-registered provider's draft (LinkedHashMap insertion order): the
     *  incoming editor is the user's current view, so its content wins. */
    fun flush() {
        // A live flush is reading the editor first; writing the older
        // change-fed draft now would leave the newer text a stale base.
        currentDrafts().forEach { persist(it) }
    }

    /** The editor registers how to bring its draft up to date with the LIVE
     *  editor — the read a leave-foreground flush makes first ([flushAfterEditor]). */
    fun setFlushWaiter(token: Long, refresher: suspend () -> Unit) {
        if (token > retiredThrough) flushWaiters[token] = refresher
    }

    suspend fun flushAfterEditor(budgetMs: Long = EDITOR_FLUSH_BUDGET_MS) {
        val readers = flushWaiters.values.toList()
        if (readers.isEmpty()) {
            flush()
            return
        }
        try {
            // Bounded as a whole: a read that never returns must not hold the
            // change-fed flush back for good.
            withTimeoutOrNull(budgetMs) {
                readers.forEach { refresh ->
                    try {
                        refresh()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: Exception) {
                        // The refresher logs its own failure; this draft is
                        // flushed as the editor last reported it.
                    }
                }
            }
        } finally {
            flush()
        }
    }

    /** Snapshot and coalesce the live drafts for an exclusive vault operation. */
    fun currentDrafts(): List<PendingDraft> {
        val byId = LinkedHashMap<String, PendingDraft>()
        retained.values.forEach { byId[it.id] = it }
        providers.values.toList().forEach { provider -> provider()?.let { byId[it.id] = it } }
        return byId.values.toList()
    }
}
