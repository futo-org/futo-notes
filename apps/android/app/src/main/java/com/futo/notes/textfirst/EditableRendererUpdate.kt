package com.futo.notes.textfirst

import android.text.Editable

/** One final-coordinate repaint envelope, including the exact old/new text lengths. */
internal data class RendererChange(val start: Int, val before: Int, val after: Int)

/**
 * The renderer knows all edits and style windows before touching the attached
 * Editable. Publish them as one coherent change: DynamicLayout then measures
 * final styles once, while native selection/composition spans still notify.
 */
internal fun Editable.withRendererUpdate(update: UiUpdate, block: () -> Unit) {
    val chunked = this as? ChunkedEditable
    val change = rendererChange(length, update.edits, update.windows)
    if (chunked == null || change == null) { block(); return }
    check(chunked.rendererChange == null) { "Nested renderer update" }
    val oldLength = length
    val watchers = chunked.textWatchers.toTypedArray()
    chunked.rendererChange = change
    var began = false
    var primary: Throwable? = null
    try {
        for (watcher in watchers) watcher.beforeTextChanged(this, change.start, change.before, change.after)
        began = true
        block()
    } catch (error: Throwable) {
        primary = error
        throw error
    } finally {
        chunked.rendererChange = null
        if (began) {
            val landed = if (length == oldLength - change.before + change.after) change
                else RendererChange(0, oldLength, length)
            var completionError: Throwable? = null
            fun remember(error: Throwable) {
                val prior = completionError
                if (prior == null) completionError = error else if (prior !== error) prior.addSuppressed(error)
            }
            for (watcher in watchers) try {
                watcher.onTextChanged(this, landed.start, landed.before, landed.after)
            } catch (error: Throwable) { remember(error) }
            for (watcher in watchers) try {
                watcher.afterTextChanged(this)
            } catch (error: Throwable) { remember(error) }
            completionError?.let { error ->
                val original = primary
                if (original == null) throw error
                if (original !== error) original.addSuppressed(error)
            }
        }
    }
}

/** Merge ordered edits without copying source text, then include the final style footprint. */
internal fun rendererChange(length: Int, edits: List<TextEdit>, windows: List<StyleWindow>): RendererChange? {
    var start = Int.MAX_VALUE
    var end = 0
    var delta = 0
    for (edit in edits) {
        // Style-only engine changes can carry an empty delta at the note's
        // end. Its coordinate is not a text mutation or repaint footprint.
        if (edit.start == edit.end && edit.text.isEmpty()) continue
        start = minOf(start, edit.start)
        end = maxOf(end, edit.end) + edit.text.length - (edit.end - edit.start)
        delta += edit.text.length - (edit.end - edit.start)
    }
    val finalLength = length + delta
    for (window in windows) {
        // Canonical table/block metadata may reach beyond the prefix that is
        // currently attached. Only its applicable renderer footprint reflows.
        require(window.start >= 0)
        if (window.start >= finalLength) continue
        start = minOf(start, window.start)
        end = maxOf(end, if (window.end >= finalLength - 1) finalLength else window.end)
    }
    if (start == Int.MAX_VALUE) return null
    require(start in 0..end && end <= finalLength) { "Renderer footprint outside the Editable" }
    return RendererChange(start, end - start - delta, end - start)
}
