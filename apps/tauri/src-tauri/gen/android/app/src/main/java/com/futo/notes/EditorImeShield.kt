package com.futo.notes

import android.webkit.JavascriptInterface
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Shadow of the editor's text + selection, read by [FutoImeConnection]
 * to answer IME queries without round-tripping to Chromium's renderer.
 *
 * See `FutoImeConnection.kt` and `docs/learnings/ime-shield-workaround.md`. DO
 * NOT REMOVE without understanding why this exists.
 *
 * # Sync model
 *
 * JS calls [update] from a CM6 `ViewPlugin` on every doc/selection
 * change. The bridge is installed on the WebView in
 * [MainActivity.onWebViewCreate] via `addJavascriptInterface`, exposed
 * to JS as `window.__FutoImeShield__`. Calls cross the JNI boundary
 * synchronously from JS's perspective; we just store the values.
 *
 * Thread-safety:
 *   - IME thread (calling `getTextBeforeCursor` etc.) is NOT the UI
 *     thread on most devices. We use an [AtomicReference] holding an
 *     immutable [Snapshot] so reads see a consistent
 *     (text, selStart, selEnd, serial) tuple without locks or torn
 *     reads.
 *   - JS-side calls land via the JavascriptInterface, which Android
 *     dispatches on a dedicated "JsBridge" thread.
 *   - `active` is true only while the CodeMirror note body is focused.
 *     The WebView's InputConnection is shared by every editable in the
 *     page (title input, dialogs, search boxes, CM6). Without this gate,
 *     the empty-body shield also swallows backspace in the title field.
 *
 * # Failure mode
 *
 * If [update] hasn't been called yet (cold start, before the editor
 * mounts), [snapshot] returns an empty snapshot. Reads against empty
 * text are safe (they return "" / null). This is also the default we
 * fall back to on any inconsistency.
 */
object EditorImeShield {

    data class Snapshot(
        val text: String,
        val selStart: Int,
        val selEnd: Int,
        val serial: Long,
        val active: Boolean,
    )

    private val EMPTY = Snapshot(text = "", selStart = 0, selEnd = 0, serial = 0L, active = false)

    private val state = AtomicReference<Snapshot>(EMPTY)
    private val updateCount = AtomicLong(0L)
    private val resetCount = AtomicLong(0L)
    private val activeCount = AtomicLong(0L)
    private val inactiveCount = AtomicLong(0L)
    private val readBeforeCount = AtomicLong(0L)
    private val readAfterCount = AtomicLong(0L)
    private val selectedTextCount = AtomicLong(0L)
    private val capsModeCount = AtomicLong(0L)
    private val extractedTextCount = AtomicLong(0L)
    private val surroundingTextCount = AtomicLong(0L)
    private val emptyDeleteCount = AtomicLong(0L)
    private val emptyDeleteCodePointsCount = AtomicLong(0L)
    private val emptyKeyDeleteCount = AtomicLong(0L)
    private val emptyBatchCount = AtomicLong(0L)
    private val emptyCompositionCount = AtomicLong(0L)
    private val emptySelectionCount = AtomicLong(0L)
    private val emptyPrivateCommandCount = AtomicLong(0L)
    private val emptyCursorUpdateCount = AtomicLong(0L)
    private val forwardedDeleteCount = AtomicLong(0L)
    private val forwardedKeyDeleteCount = AtomicLong(0L)

    /**
     * Highest serial number we've seen so far. Used only for
     * monotonicity checks — out-of-order JS calls (in theory
     * impossible but cheap to guard against) are ignored.
     */
    private val highWater = AtomicLong(0L)

    /** Returns the current shadow snapshot. Never blocks, never null. */
    fun snapshot(): Snapshot = state.get() ?: EMPTY

    /**
     * Called from JS via `window.__FutoImeShield__.update(...)`.
     *
     * Parameters use simple types (String, int, long) because
     * `@JavascriptInterface` only marshals primitives + Strings.
     *
     * `serial` is a monotonic counter from the JS side, incremented
     * on every CM6 update. Older serials are dropped.
     */
    @JavascriptInterface
    fun update(text: String?, selStart: Int, selEnd: Int, serial: Long) {
        val safeText = text ?: ""
        // Drop out-of-order updates.
        var prev: Long
        do {
            prev = highWater.get()
            if (serial <= prev) return
        } while (!highWater.compareAndSet(prev, serial))

        val len = safeText.length
        val s = selStart.coerceAtLeast(0).coerceAtMost(len)
        val e = selEnd.coerceAtLeast(s).coerceAtMost(len)
        val active = snapshot().active
        state.set(Snapshot(safeText, s, e, serial, active))
        updateCount.incrementAndGet()
    }

    /**
     * Called from JS focus/blur handlers on the CM6 editor. This is the
     * safety gate that keeps the WebView-wide InputConnection wrapper
     * from affecting normal HTML inputs such as the note title field.
     */
    @JavascriptInterface
    fun setActive(active: Boolean) {
        state.updateAndGet { current ->
            val s = current ?: EMPTY
            s.copy(active = active)
        }
        if (active) activeCount.incrementAndGet() else inactiveCount.incrementAndGet()
    }

    /**
     * Optional: JS can call this to clear the shadow when the editor
     * loses focus or the route changes away from a note. Not strictly
     * required (the next [update] supersedes), but lets reads serve
     * empty during route transitions when the active editable doesn't
     * actually belong to CM6.
     */
    @JavascriptInterface
    fun reset() {
        // Bump the highWater so a stale in-flight update can't undo
        // the reset. The next real update will use a serial > prev+1.
        highWater.incrementAndGet()
        state.set(EMPTY)
        resetCount.incrementAndGet()
    }

    fun noteReadBefore() { readBeforeCount.incrementAndGet() }
    fun noteReadAfter() { readAfterCount.incrementAndGet() }
    fun noteSelectedText() { selectedTextCount.incrementAndGet() }
    fun noteCapsMode() { capsModeCount.incrementAndGet() }
    fun noteExtractedText() { extractedTextCount.incrementAndGet() }
    fun noteSurroundingText() { surroundingTextCount.incrementAndGet() }
    fun noteEmptyDelete() { emptyDeleteCount.incrementAndGet() }
    fun noteEmptyDeleteCodePoints() { emptyDeleteCodePointsCount.incrementAndGet() }
    fun noteEmptyKeyDelete() { emptyKeyDeleteCount.incrementAndGet() }
    fun noteEmptyBatch() { emptyBatchCount.incrementAndGet() }
    fun noteEmptyComposition() { emptyCompositionCount.incrementAndGet() }
    fun noteEmptySelection() { emptySelectionCount.incrementAndGet() }
    fun noteEmptyPrivateCommand() { emptyPrivateCommandCount.incrementAndGet() }
    fun noteEmptyCursorUpdate() { emptyCursorUpdateCount.incrementAndGet() }
    fun noteForwardedDelete() { forwardedDeleteCount.incrementAndGet() }
    fun noteForwardedKeyDelete() { forwardedKeyDeleteCount.incrementAndGet() }

    /**
     * Short, crash-report-friendly summary. This is load-bearing
     * diagnostics for the FUTO Keyboard renderer crash: if a future
     * crash report shows all counters at zero, the wrapper was bypassed
     * or the wrong APK was installed. If read counters increment but
     * empty-delete counters do not, the next crash path is likely a
     * different InputConnection mutation.
     */
    fun telemetrySummary(): String {
        val s = snapshot()
        return "shadow(active=${s.active},len=${s.text.length},sel=${s.selStart}..${s.selEnd},serial=${s.serial}) " +
            "updates=${updateCount.get()} resets=${resetCount.get()} " +
            "active=${activeCount.get()} inactive=${inactiveCount.get()} " +
            "reads(before=${readBeforeCount.get()},after=${readAfterCount.get()}," +
            "selected=${selectedTextCount.get()},surrounding=${surroundingTextCount.get()}," +
            "extracted=${extractedTextCount.get()},caps=${capsModeCount.get()}) " +
            "emptyDeletes(chars=${emptyDeleteCount.get()},codepoints=${emptyDeleteCodePointsCount.get()}," +
            "key=${emptyKeyDeleteCount.get()}) emptyNoops(batch=${emptyBatchCount.get()}," +
            "composition=${emptyCompositionCount.get()},selection=${emptySelectionCount.get()}," +
            "private=${emptyPrivateCommandCount.get()},cursor=${emptyCursorUpdateCount.get()}) " +
            "forwardedDeletes(chars=${forwardedDeleteCount.get()}," +
            "key=${forwardedKeyDeleteCount.get()})"
    }

    /**
     * Debugging hook. Returns the current shadow as a short summary
     * string. Safe to call from JS for inspection from devtools.
     */
    @JavascriptInterface
    fun debugSummary(): String {
        return telemetrySummary()
    }
}
