package com.futo.notes.textfirst

import android.util.Log
import uniffi.futo_notes_ffi.EditorBlockBoundary
import uniffi.futo_notes_ffi.EditorByteRange
import uniffi.futo_notes_ffi.EditorDisplayByteOffset
import uniffi.futo_notes_ffi.EditorSessionException

// Block movement (#311, #444): the engine says what a press at a display position lifts (an
// image that shares its line, alone; else the lines its line lifts), where it may land, and
// moves it as one Undo step. The view only names display positions: UTF-16 offsets here,
// display bytes to the engine. Puppet's `MoveBlock` and the long-press drag (BlockDrag.kt)
// both come through here. Editor thread unless a function says otherwise.

/** What a press lifts and where it may land near the screen, at the engine's [revision], in the view's coordinates at update [seq]. */
internal class LiftPlan(val press: Int, val block: LiftedBlock, val slots: List<BlockSlot>, val covered: IntRange, val revision: ULong, val seq: Int)

private fun EditorEngine.byteAt(offset: Int) = EditorDisplayByteOffset(mirror.toByte(offset).toULong())

/** What a press at [offset] lifts; null when it lifts nothing (a blank line, front matter, code nothing closes). */
internal fun EditorEngine.liftedBlock(offset: Int): LiftedBlock? {
    val s = session ?: return null
    val block = s.blockAt(rev, byteAt(offset)) ?: return null
    return LiftedBlock(mirror.toUtf16(block.range.start.toInt()), mirror.toUtf16(block.range.end.toInt()), block.toEnd)
}

/** Where what a press at [offset] lifts may land among the boundaries in [within] (both ends included), in order. */
internal fun EditorEngine.blockSlots(offset: Int, within: IntRange): List<BlockSlot> {
    val s = session ?: return emptyList()
    val range = EditorByteRange(mirror.toByte(within.first).toULong(), mirror.toByte(within.last).toULong())
    return s.blockSlots(rev, byteAt(offset), range).map { BlockSlot(mirror.toUtf16(it.offset.toInt()), it.end) }
}

/**
 * Move what a press at [offset] lifts to [slot]. False when the engine refuses (no block, or
 * not one of its slots); the note is then unchanged. [drop] rides on the view update the move
 * posts, so the view holds its place in the same frame the text moves.
 */
internal fun EditorEngine.moveBlock(offset: Int, slot: BlockSlot, drop: DropHold? = null): Boolean {
    val s = session ?: return false
    if (mirror.overlay != null) commitComposition(null)
    val change = s.moveBlock(rev, byteAt(offset), EditorBlockBoundary(mirror.toByte(slot.offset).toULong(), slot.end)) ?: return false
    pendingDrop = drop ?: DropHold.KEEP
    try { accept(change) } finally { pendingDrop = null }
    return true
}

/**
 * A long-press lifts at [press] (view coordinates at update [viewSeq]): settle a composition and
 * say what lifts and its slots within [near], which the view already holds. A note still
 * streaming in is not waited for: its rest keeps coming during the drag (RenderHold.dragging).
 * [done] runs on the UI thread with null when nothing lifts or the editor cannot answer.
 */
internal fun EditorEngine.planLift(viewSeq: Int, press: Int, near: IntRange, done: (LiftPlan?) -> Unit) = handler.post {
    var plan: LiftPlan? = null
    if (!closed && session != null && storageGate?.isMigrationStarted != true) try {
        if (mirror.overlay != null) commitComposition(null)
        val mapped = viewEdits.map(viewSeq, press, press)
        val range = viewEdits.map(viewSeq, near.first, near.last)
        if (mapped != null && range != null) {
            val at = mapped.first
            val within = range.first.coerceIn(0, mirror.text.length)..range.second.coerceIn(0, mirror.text.length)
            liftedBlock(at)?.let { block -> plan = LiftPlan(at, block, blockSlots(at, within), within, rev, seq) }
        }
    } catch (e: EditorSessionException) {
        Log.w(EditorEngine.TAG, "block lift refused: $e")
    }
    val answer = plan
    ui.post { done(answer) }
}

/**
 * More slots for the block a press at [press] lifted at [revision], within each of [asks].
 * [done] runs on the UI thread with null when the note changed since (the drag must end).
 */
internal fun EditorEngine.moreSlots(press: Int, revision: ULong, asks: List<IntRange>, done: (List<BlockSlot>?) -> Unit) = handler.post {
    val found = if (closed || session == null || rev != revision) null else try {
        asks.flatMap { ask -> blockSlots(press, ask.first.coerceIn(0, mirror.text.length)..ask.last.coerceIn(0, mirror.text.length)) }
    } catch (e: EditorSessionException) {
        Log.w(EditorEngine.TAG, "block slots refused: $e")
        null
    }
    ui.post { done(found) }
}

/** Drop the block lifted at [revision] on [slot]; [done] runs on the UI thread with whether it moved. */
internal fun EditorEngine.dropBlock(press: Int, slot: BlockSlot, revision: ULong, drop: DropHold?, done: (Boolean) -> Unit) = handler.post {
    var moved = false
    // Text being composed since the lift moved the display under [press] and [slot]: refused, nothing committed.
    if (!closed && session != null && storageGate?.isMigrationStarted != true && rev == revision && mirror.overlay == null) try {
        moved = moveBlock(press, slot, drop)
    } catch (e: EditorSessionException) {
        handleFailure(e)
    }
    ui.post { done(moved) }
}
