package com.futo.notes.textfirst

import android.text.Editable
import android.text.TextPaint
import android.text.style.CharacterStyle
import android.widget.TextView

/** One final-coordinate repaint envelope, including the exact old/new text lengths. */
internal data class RendererChange(val start: Int, val before: Int, val after: Int)

/**
 * The renderer knows all edits and style windows before touching the attached
 * Editable. Publish them as one coherent change: DynamicLayout then measures
 * final styles once, while native selection/composition spans still notify.
 *
 * DynamicLayout reuses a drawn display list per block of lines, and when a
 * reflow keeps the line count it leaves the blocks below the edit where they
 * were drawn. A heading toggled to a paragraph keeps its lines but is shorter,
 * so everything under it would stay at its old screen position while the layout
 * (and touch, caret and scroll) hold the new one. [view] lets this notice that
 * and ask for the lines below to be redrawn where they now are.
 */
internal fun Editable.withRendererUpdate(view: TextView, update: UiUpdate, windows: List<StyleWindow> = update.windows, block: () -> Unit) {
    val chunked = this as? ChunkedEditable
    val change = rendererChange(length, update.edits, windows)
    if (chunked == null || change == null) { block(); return }
    check(chunked.rendererChange == null) { "Nested renderer update" }
    val oldLength = length
    val layoutBefore = view.layout
    val linesBefore = layoutBefore?.lineCount ?: 0
    val heightBefore = layoutBefore?.height ?: 0
    val watchers = chunked.textWatchers.toTypedArray()
    val selection = if (update.edits.any { it.start != it.end || it.text.isNotEmpty() })
        ChunkedSelectionNotifications(chunked) else null
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
            val layoutAfter = view.layout
            if (layoutAfter != null && layoutAfter === layoutBefore &&
                layoutAfter.lineCount == linesBefore && layoutAfter.height != heightBefore
            ) chunked.redrawFrom(landed.start)
            for (watcher in watchers) try {
                watcher.afterTextChanged(this)
            } catch (error: Throwable) { remember(error) }
            try { selection?.afterReplace(landed.start + landed.after) }
            catch (error: Throwable) { remember(error) }
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

/**
 * Tell the attached TextView that the text from [start] on must be redrawn.
 * It is told as a change of an appearance span, the one notification that
 * drops the cached display lists of the lines it covers; a layout reflow
 * that keeps the line count moves nothing below its own lines (see
 * [withRendererUpdate]). DynamicLayout ignores it, so nothing is measured again.
 */
private fun ChunkedEditable.redrawFrom(start: Int) {
    for (w in spanWatchers.toTypedArray()) w.onSpanChanged(this, Redraw, start, length, start, length)
}

private object Redraw : CharacterStyle() {
    override fun updateDrawState(tp: TextPaint) = Unit
}
