package com.futo.notes.ui

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

internal data class DocumentSnapshot(val generation: Long, val content: String)
internal data class EditorCurrent(val latest: DocumentSnapshot?, val behind: Boolean, val rendererGone: Boolean = false) {
    val canProceed: Boolean get() = !behind || rendererGone
}

/** The host's only source of document text. All calls run on the UI thread. */
internal class EditorMailbox {
    private class Entry {
        var latest: DocumentSnapshot? = null
        var editedThrough = 0L
        var acceptedThrough = -1L
        var gone = false
        val waiters = mutableMapOf<String, CompletableDeferred<Boolean>>()
    }
    private val entries = mutableMapOf<String, Entry>()
    private val bindings = mutableMapOf<Long, Pair<String, (String) -> Unit>>()
    private val retained = mutableMapOf<String, (String) -> Unit>()
    fun bind(owner: Long, id: String, change: (String) -> Unit) { bindings[owner] = id to change }
    fun detach(owner: Long) { bindings.remove(owner) }
    /** A rename: the editor's next report for [from]'s document arrives as [to]. */
    fun retarget(from: String, to: String) {
        bindings.entries.filter { it.value.first == from }.forEach { it.setValue(to to it.value.second) }
    }
    fun retainUnflushed(id: String, deliver: (String) -> Unit) {
        if (!current(id).canProceed) retained[id] = deliver
    }
    private var sequence = 0L
    private fun entry(id: String) = entries.getOrPut(id) { Entry() }
    fun current(id: String): EditorCurrent = entry(id).let {
        EditorCurrent(it.latest, (it.latest?.generation ?: 0) < it.editedThrough, it.gone)
    }
    fun prepareLoad(id: String) {
        val m = entry(id)
        if (!current(id).canProceed) return
        m.latest = null
        m.editedThrough = 0
    }
    fun loaded(id: String, generation: Long, content: String) {
        val m = entry(id)
        // A renderer reload starts a new page-monotonic generation domain.
        if (m.gone) { m.latest = null; m.editedThrough = 0; m.acceptedThrough = -1; m.gone = false }
        if (generation < m.acceptedThrough) return
        m.latest = DocumentSnapshot(generation, content)
        m.acceptedThrough = generation
        m.editedThrough = maxOf(m.editedThrough, generation)
        satisfy(id)
    }
    fun edited(id: String, generation: Long) {
        val m = entry(id)
        if (generation > m.acceptedThrough) m.editedThrough = maxOf(m.editedThrough, generation)
    }
    fun change(id: String, generation: Long, content: String): Boolean {
        val m = entry(id)
        if (generation <= m.acceptedThrough) { satisfy(id); return false }
        m.latest = DocumentSnapshot(generation, content)
        m.acceptedThrough = generation
        bindings.values.filter { it.first == id }.toList().forEach { it.second(content) }
        if (current(id).canProceed) retained.remove(id)?.invoke(content)
        satisfy(id)
        return true
    }
    private fun satisfy(id: String) {
        val m = entry(id)
        if (current(id).canProceed) m.waiters.values.toList().forEach { it.complete(true) }
    }
    fun failed(id: String, token: String) { entry(id).waiters[token]?.complete(false) }
    fun prune(keeping: String) {
        entries.keys.toList().filter { id ->
            id != keeping && entry(id).waiters.isEmpty() && retained[id] == null &&
                bindings.values.none { it.first == id } && current(id).canProceed
        }.forEach { entries.remove(it) }
    }
    fun rendererGone() {
        retained.clear()
        entries.values.forEach { m -> m.gone = true; m.waiters.values.toList().forEach { it.complete(false) } }
    }
    /** Identity handoff: wait for a real load acknowledgment before conditional adoption. */
    suspend fun awaitLoaded(id: String, deadlineMs: Long = 6_000, load: () -> Unit): EditorCurrent {
        val now = current(id)
        if (now.latest != null || now.rendererGone) return now
        val token = "load-${++sequence}"
        val waiter = CompletableDeferred<Boolean>()
        val m = entry(id)
        m.waiters[token] = waiter
        try {
            load()
            withTimeoutOrNull(deadlineMs) { waiter.await() }
            return current(id)
        } finally { m.waiters.remove(token) }
    }
    suspend fun awaitCurrent(id: String, deadlineMs: Long = 6_000, flush: (String) -> Unit): EditorCurrent {
        val now = current(id)
        if (now.canProceed) return now
        val token = "flush-${++sequence}"
        val waiter = CompletableDeferred<Boolean>()
        val m = entry(id)
        m.waiters[token] = waiter
        try {
            flush(token)
            withTimeoutOrNull(deadlineMs) { waiter.await() }
            return current(id)
        } finally { m.waiters.remove(token) }
    }
}
