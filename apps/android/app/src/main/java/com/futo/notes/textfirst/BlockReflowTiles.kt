package com.futo.notes.textfirst

import android.graphics.Canvas
import android.graphics.RenderNode
import android.os.Build
import android.text.Layout

/**
 * The note's own drawing, recorded once per [TILE] px of content into a RenderNode (API 29+), so
 * the reflow preview (#450) draws a slice at its previewed place each frame for a few
 * drawRenderNode calls instead of laying out its lines again: drawing every slice through the
 * layout cost 15 ms a frame on the Moto G Play. A slice is the tiles it spans, clipped to it and
 * moved by its shift. Tiles are recorded as they first show, dropped once well off screen, and
 * all recorded again when the note's layout or text changes. On API 28, and on a canvas that is
 * not hardware accelerated, slices are drawn through the layout directly.
 */
internal class SliceTiles(private val view: TextFirstEditText) {
    private val tiles = HashMap<Int, RenderNode>()
    /** The tiles drawn this frame: the frame's display list refers to them until the render thread has drawn it. */
    private val used = HashSet<Int>()
    private var layout: Layout? = null
    private var height = -1
    private var width = -1
    private var seq = -1

    /** Draw the note laid out from [from] to [to], [shift] lower, where it shows between [top] and [bottom]. */
    fun draw(canvas: Canvas, from: Float, to: Float, shift: Float, top: Float, bottom: Float) {
        if (Build.VERSION.SDK_INT < 29 || !canvas.isHardwareAccelerated) return view.drawSlice(canvas, from, to, shift, top, bottom)
        val a = maxOf(from + shift, top)
        val b = minOf(to + shift, bottom)
        if (b <= a) return
        current()
        val save = canvas.save()
        canvas.clipRect(view.scrollX.toFloat(), a, (view.scrollX + view.width).toFloat(), b)
        for (k in tileOf(a - shift)..tileOf(b - shift - 0.01f)) {
            val node = tiles.getOrPut(k) { record(k) }
            used += k
            canvas.save()
            canvas.translate(0f, k * TILE + shift)
            canvas.drawRenderNode(node)
            canvas.restore()
        }
        canvas.restoreToCount(save)
    }

    /** Record the tiles on screen now, ahead of the first frame that needs them. */
    fun warm() {
        if (Build.VERSION.SDK_INT < 29 || !view.isHardwareAccelerated) return
        current()
        for (k in tileOf(view.scrollY.toFloat())..tileOf(view.scrollY + view.height - 0.01f)) tiles.getOrPut(k) { record(k) }
    }

    /**
     * Drop the tiles more than a screen away from what shows that this frame did not draw (call
     * after a frame). A tile this frame drew stays, though laid out far away (the copy in the gap
     * is drawn from the block's own place, which autoscroll may have left screens behind):
     * discarding it would empty the frame's display list before the render thread draws it.
     */
    fun trim() {
        if (Build.VERSION.SDK_INT < 29) return
        val keep = tileOf(view.scrollY.toFloat() - view.height)..tileOf(view.scrollY + 2f * view.height)
        tiles.entries.removeAll { (k, node) -> (k !in keep && k !in used).also { if (it) node.discardDisplayList() } }
        used.clear()
    }

    fun clear() {
        if (Build.VERSION.SDK_INT >= 29) for (node in tiles.values) node.discardDisplayList()
        tiles.clear()
        used.clear()
    }

    private fun tileOf(y: Float) = kotlin.math.floor(y / TILE).toInt()

    /** The note laid out or written differently since the tiles were recorded: record them again. */
    private fun current() {
        val l = view.layout
        if (l === layout && l?.height == height && view.width == width && view.appliedSeq == seq) return
        clear()
        layout = l
        height = l?.height ?: -1
        width = view.width
        seq = view.appliedSeq
    }

    @androidx.annotation.RequiresApi(29)
    private fun record(k: Int): RenderNode {
        val node = RenderNode("note-slice")
        node.setPosition(0, 0, view.scrollX + view.width, TILE.toInt())
        val c = node.beginRecording()
        try {
            c.translate(0f, -k * TILE)
            view.drawNoteRegion(c, k * TILE, (k + 1) * TILE)
        } finally {
            node.endRecording()
        }
        return node
    }

    companion object {
        const val TILE = 256f
    }
}
