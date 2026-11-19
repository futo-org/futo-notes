package com.futo.notes.textfirst

import android.view.MotionEvent

/** The note's own touch handlers, in order, then the platform's; a lift hands them a CANCEL. */
internal fun TextFirstEditText.routeTouch(event: MotionEvent): Boolean {
    if (event.actionMasked == MotionEvent.ACTION_DOWN) { restoring = null; stopPinning(); scroll.down(event) } else scroll.track(event)
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
        MotionEvent.ACTION_DOWN -> {
            checkboxDown = checkboxAt(this, style, event.x, event.y)
            if (checkboxDown >= 0) return true
        }
        MotionEvent.ACTION_UP -> if (checkboxDown >= 0) {
            val hit = checkboxAt(this, style, event.x, event.y)
            if (hit == checkboxDown) engine?.toggleTaskAt(hit)
            checkboxDown = -1
            return true
        }
        MotionEvent.ACTION_MOVE -> if (checkboxDown >= 0) return true
        MotionEvent.ACTION_CANCEL -> if (checkboxDown >= 0) { checkboxDown = -1; return true }
    }
    return nativeTouch(event).also {
        imageTouch.settleSelection(); codeTouch.settleTap(event); lineBelowHandle.onTouch(event); revealTappedCaret(event)
    }
}
