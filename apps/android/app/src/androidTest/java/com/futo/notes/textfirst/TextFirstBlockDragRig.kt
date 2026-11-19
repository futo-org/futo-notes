package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.os.SystemClock
import android.view.ActionMode
import android.view.InputDevice
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.NotesStore
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.Localization
import com.futo.notes.ui.theme.FutoNotesTheme
import java.io.File
import java.util.UUID
import kotlin.math.abs

internal typealias DragRule = AndroidComposeTestRule<ActivityScenarioRule<ComponentActivity>, ComponentActivity>

internal class RecordingHaptics : DragHaptics {
    var lifts = 0; var ticks = 0; var lands = 0
    override fun lifted() { lifts++ }
    override fun reachedSlot() { ticks++ }
    override fun landed() { lands++ }
}

/** A note open on the real note screen, keyboard down, driven with touches injected through the window. */
internal class BlockDragRig(val compose: DragRule, val view: TextFirstEditText, val file: File) {
    private val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
    val haptics = RecordingHaptics().also { h -> ui { view.blockLift.haptics = h } }
    /** Text menus the platform opened on the note (selection or insertion). */
    var menus = 0

    init {
        ui {
            val selection = view.customSelectionActionModeCallback
            val insertion = view.customInsertionActionModeCallback
            view.customSelectionActionModeCallback = counting(selection)
            view.customInsertionActionModeCallback = counting(insertion)
        }
    }

    private fun counting(inner: ActionMode.Callback?) = object : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean { menus++; return inner?.onCreateActionMode(mode, menu) ?: true }
        override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = inner?.onPrepareActionMode(mode, menu) ?: false
        override fun onActionItemClicked(mode: ActionMode, item: MenuItem) = inner?.onActionItemClicked(mode, item) ?: false
        override fun onDestroyActionMode(mode: ActionMode) { inner?.onDestroyActionMode(mode) }
    }

    fun <T> ui(block: () -> T): T {
        var out: T? = null
        compose.runOnUiThread { out = block() }
        @Suppress("UNCHECKED_CAST") return out as T
    }

    private fun onScreen(): IntArray = IntArray(2).also(view::getLocationOnScreen)
    private fun windowOnScreen(): IntArray = IntArray(2).also(view.rootView::getLocationOnScreen)

    /** The screen point on the row holding display [offset], [fraction] down that row, [x] px into the text. */
    fun at(offset: Int, fraction: Float = 0.5f, x: Float = 60f): PointF = ui {
        val l = view.layout
        val line = l.getLineForOffset(offset)
        val loc = onScreen()
        val top = l.getLineTop(line)
        PointF(loc[0] + view.totalPaddingLeft + x,
            loc[1] + view.totalPaddingTop - view.scrollY + top + (l.getLineBottom(line) - top) * fraction)
    }

    fun offsetOf(text: String): Int = ui { view.text.toString().indexOf(text) }.also { check(it >= 0) { "no $text" } }

    private var downTime = 0L
    private fun send(action: Int, p: PointF) {
        last = p
        val e = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, p.x, p.y, 0)
        e.source = InputDevice.SOURCE_TOUCHSCREEN
        try { check(automation.injectInputEvent(e, true)) } finally { e.recycle() }
    }

    fun down(p: PointF) { downTime = SystemClock.uptimeMillis(); send(MotionEvent.ACTION_DOWN, p) }
    /** A finger that holds still sends nothing. */
    fun hold(ms: Long) = SystemClock.sleep(ms)
    fun moveTo(from: PointF, to: PointF, steps: Int = 12) {
        for (i in 1..steps) {
            send(MotionEvent.ACTION_MOVE, PointF(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps))
            SystemClock.sleep(16)
        }
    }
    fun up(p: PointF) = send(MotionEvent.ACTION_UP, p)
    private var last = PointF()
    /** End whatever injected gesture a failed test left down, so the next test's touches are accepted. */
    fun release() { if (downTime != 0L) runCatching { send(MotionEvent.ACTION_CANCEL, last) } }

    /** Hand the view one multi-touch event directly (screen points), as its window would. */
    fun dispatch(action: Int, points: List<PointF>, flags: Int = 0) = ui {
        val loc = onScreen()
        val props = Array(points.size) { MotionEvent.PointerProperties().apply { id = it; toolType = MotionEvent.TOOL_TYPE_FINGER } }
        val coords = Array(points.size) { MotionEvent.PointerCoords().apply { x = points[it].x - loc[0]; y = points[it].y - loc[1]; pressure = 1f; size = 1f } }
        val e = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, points.size, props, coords, 0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_TOUCHSCREEN, flags)
        try { view.dispatchTouchEvent(e) } finally { e.recycle() }
    }
    fun startDirect() { downTime = SystemClock.uptimeMillis() }

    /** Hold at [from] past the lift, carry the finger to [to], hold there and let go. */
    fun drag(from: PointF, to: PointF) {
        down(from); hold(600); moveTo(from, to); hold(200); up(to)
    }

    val lifted get() = ui { view.blockLift.drag != null }

    fun saved(expected: String) {
        compose.waitUntil(5_000) { file.readText() == expected }
    }

    /**
     * The drop line and card the drag reports are on screen: the line's row is the accent
     * colour across the text, and the card's area differs from [before] (taken before the lift).
     */
    fun assertDrawn(before: Bitmap?) {
        SystemClock.sleep(150)
        val shot = automation.takeScreenshot()
        val window = ui { windowOnScreen() }
        val (line, card, accent) = ui { val d = view.blockLift.drag!!; Triple(d.dropLineInWindow(), d.cardInWindow(), view.style.linkColor) }
        checkNotNull(line) { "no drop line reported" }
        val y = (window[1] + line).toInt()
        val xs = listOf(0.3f, 0.5f, 0.7f).map { (shot.width * it).toInt() }
        for (x in xs) {
            val p = shot.getPixel(x, y)
            check(close(p, accent)) { "the drop line is not drawn at y $y x $x: #${Integer.toHexString(p)}" }
        }
        if (before == null) return
        var differs = 0
        val r = android.graphics.Rect((window[0] + card.left).toInt(), (window[1] + card.top).toInt(), (window[0] + card.right).toInt(), (window[1] + card.bottom).toInt())
        r.intersect(0, 0, shot.width, shot.height)
        for (x in r.left until r.right step 3) for (y in r.top until r.bottom step 3) if (shot.getPixel(x, y) != before.getPixel(x, y)) differs++
        check(differs > 40) { "nothing drawn where the card is reported ($card): $differs pixels differ" }
    }

    fun screenshot(): Bitmap = automation.takeScreenshot()

    /** What the reflow preview reports now (#450): the gap's slot and the dimmed copy's place; null with no preview. */
    val report get() = ui { view.blockLift.drag?.reflow?.report() }

    /** The view's top in window coordinates, and the window's on screen. */
    fun viewInWindow(): Int = ui { IntArray(2).also(view::getLocationInWindow)[1] }

    /**
     * Carry the held finger from [from] [step] px at a time (16 ms apart), drifting it to [x] so
     * the card leaves the gap's left side uncovered, until [reached]; returns where it is.
     */
    fun carryUntil(from: PointF, step: Float, x: Float = from.x, limit: Int = 300, reached: () -> Boolean): PointF {
        var at = from
        for (i in 1..limit) {
            if (reached()) return at
            at = PointF(at.x + (x - at.x) / 6f, at.y + step)
            send(MotionEvent.ACTION_MOVE, at)
            SystemClock.sleep(16)
        }
        check(reached()) { "the gap never got there (report ${report?.gap})" }
        return at
    }

    /** Ink in a window rect of [shot]: how many pixels are darker than [darker] (the page by default), and the darkest luminance. */
    fun ink(shot: Bitmap, r: android.graphics.RectF, darker: Int = 235): Pair<Int, Int> {
        val window = ui { windowOnScreen() }
        var count = 0
        var darkest = 255
        val x0 = (window[0] + r.left).toInt().coerceIn(0, shot.width)
        val x1 = (window[0] + r.right).toInt().coerceIn(0, shot.width)
        val y0 = (window[1] + r.top).toInt().coerceIn(0, shot.height)
        val y1 = (window[1] + r.bottom).toInt().coerceIn(0, shot.height)
        for (x in x0 until x1 step 2) for (y in y0 until y1 step 2) {
            val p = shot.getPixel(x, y)
            val l = (Color.red(p) * 299 + Color.green(p) * 587 + Color.blue(p) * 114) / 1000
            if (l < darker) count++
            darkest = minOf(darkest, l)
        }
        return count to darkest
    }

    /**
     * The dimmed copy is drawn where the preview reports it: in the part of its rect the card
     * leaves uncovered there is text, and none of it is darker than a 35% copy of text on the page.
     */
    fun assertCopyDrawn() {
        SystemClock.sleep(Slide.SLIDE_MS + 120)
        val shot = screenshot()
        val copy = checkNotNull(report?.copy) { "no copy reported" }
        val card = ui { view.blockLift.drag!!.cardInWindow() }
        val left = ui { view.totalPaddingLeft.toFloat() }
        val visible = android.graphics.RectF(left, copy.top + 2, minOf(copy.right, card.left - 4), copy.bottom - 2)
        check(visible.width() > 60) { "the card covers the copy ($card over $copy)" }
        val (count, darkest) = ink(shot, visible, darker = 205)
        // Text, not the card's soft shadow (about 225 at its darkest), and dimmed (35% of text on the page is about 175).
        check(count > 10 && darkest < 205) { "no text drawn in the copy at $visible (darkest $darkest)" }
        check(darkest > 120) { "the copy at $visible is not dimmed: luminance $darkest" }
    }

    /** Run [block] with animations turned off in the system's settings, as a person would turn them off. */
    fun <T> withAnimationsOff(block: () -> T): T {
        val before = shell("settings get global animator_duration_scale").trim()
        shell("settings put global animator_duration_scale 0")
        try {
            compose.waitUntil(5_000) { ui { !android.animation.ValueAnimator.areAnimatorsEnabled() } }
            return block()
        } finally {
            // Deleting the setting does not reach a running app; its default is 1.
            shell("settings put global animator_duration_scale ${before.toFloatOrNull() ?: 1f}")
            // Best effort: a timeout here must not hide the test's own failure.
            runCatching { compose.waitUntil(5_000) { ui { android.animation.ValueAnimator.areAnimatorsEnabled() } } }
        }
    }

    private fun shell(command: String): String =
        android.os.ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand(command)).bufferedReader().use { it.readText() }

    private fun close(a: Int, b: Int) =
        abs(Color.red(a) - Color.red(b)) < 40 && abs(Color.green(a) - Color.green(b)) < 40 && abs(Color.blue(a) - Color.blue(b)) < 40
}

/** Open [note] (with [files] beside it) on the note screen, keyboard down, and run [check]. */
internal fun DragRule.openDragScreen(note: String, files: Map<String, ByteArray> = emptyMap(), complete: Boolean = true, check: BlockDragRig.() -> Unit) {
    NoteScrollMemory.clear()
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    val scratch = File(context.cacheDir, "block-drag-${UUID.randomUUID()}").apply { check(mkdirs()) }
    val root = File(scratch, "vault").apply { check(mkdirs()) }
    val file = File(root, "drag.md").apply { writeText(note) }
    for ((name, bytes) in files) File(root, name).writeBytes(bytes)
    lateinit var store: NotesStore
    runOnUiThread { store = NotesStore(root, File(scratch, "index")) }
    waitUntil(15_000) { store.hasBootstrapped }
    val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
    setContent {
        FutoNotesTheme(darkTheme = false) {
            CompositionLocalProvider(LocalLocalization provides localization) {
                TextFirstEditorScreen(store, "drag", false, false, {}, {}, registerLeave = { {} })
            }
        }
    }
    fun find(view: View): TextFirstEditText? = when (view) {
        is TextFirstEditText -> view
        is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { find(view.getChildAt(it)) }
        else -> null
    }
    var editor: TextFirstEditText? = null
    waitUntil(15_000) {
        runOnUiThread {
            editor = find(activity.window.decorView)?.takeIf { it.liftAllowed() && it.length() > 1 && (!complete || it.contentComplete) }
        }
        editor != null
    }
    // The bare test activity has no AppCompat theme, so the EditText style that makes it focusable is absent.
    runOnUiThread { editor!!.isFocusableInTouchMode = true }
    val rig = BlockDragRig(this, editor!!, file)
    try {
        rig.check()
    } finally {
        rig.release()
        scratch.deleteRecursively()
    }
}

internal fun png(width: Int, height: Int, color: Int = Color.CYAN): ByteArray = java.io.ByteArrayOutputStream().also {
    Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).apply { eraseColor(color) }.compress(Bitmap.CompressFormat.PNG, 100, it)
}.toByteArray()
