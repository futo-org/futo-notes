package com.futo.notes.textfirst

import android.view.MotionEvent

/** The note's own touch handlers, in order, then the platform's; a lift hands them a CANCEL. */
internal fun TextFirstEditText.routeTouch(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) { restoring = null; stopPinning(); scroll.down(event) } else scroll.track(event)
    caretEdge.onNoteTouch(event)
    listMarkerTouch.onTouch(event)
    // Any lift may leave handles the platform shows anew (a tap, a swipe that brings a selection back on screen).
    if (event.actionMasked == MotionEvent.ACTION_UP) handleWatch.searchAfterLift()
    // A scroll that claims the contact keeps it: no block lifts from it (BlockLift.kt).
    if (!scroll.stoppingTouch && tableTouch.onTouch(event)) return true.also { if (tableTouch.scrolling) blockLift.scrollClaimed() }
    if (scroll.own(event) { nativeTouch(it) }) return true.also { if (scroll.dragging) blockLift.scrollClaimed() }
    if (onOpenUrl != null && linkTouch.onTouch(event)) return true
    if (wikilinkTouch.onTouch(event)) return true
    imageTouch.onTouch(event)
    // After the links, so a third quick tap on a link still opens it.
    if (lineTouch.onTouch(event)) return true
    if (codeTouch.onTouch(event)) return true
    when (event.actionMasked) {
        // The platform sees a checkbox press too, so a hold selects the box (ListMarkerTouch); a tap ticks it and the
        // platform's tap is cancelled, so it places no caret. After a hold there is no tick.
        MotionEvent.ACTION_DOWN -> {
            checkboxDown = checkboxAt(this, style, event.x, event.y)
            if (checkboxDown >= 0) return true.also { nativeTouch(event) }
        }
        MotionEvent.ACTION_UP -> if (checkboxDown >= 0) {
            val hit = checkboxAt(this, style, event.x, event.y)
            val box = checkboxDown
            checkboxDown = -1
            if (listMarkerTouch.held) return nativeTouch(event)
            cancelNativeTouch(event)
            if (hit == box) engine?.toggleTaskAt(hit)
            return true
        }
        MotionEvent.ACTION_MOVE -> if (checkboxDown >= 0) return true
        MotionEvent.ACTION_CANCEL -> if (checkboxDown >= 0) { checkboxDown = -1; return true.also { nativeTouch(event) } }
    }
    return nativeTouch(event).also {
        imageTouch.settleSelection(); codeTouch.settleTap(event); lineBelowHandle.onTouch(event); revealTappedCaret(event)
    }
}

/** End the platform's half of a press the note handled itself, so it neither places a caret nor long-presses. */
private fun TextFirstEditText.cancelNativeTouch(event: MotionEvent) {
    val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
    try { nativeTouch(cancel) } finally { cancel.recycle() }
}
