package com.futo.notes.textfirst

import android.graphics.Rect
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*

/** Match MainActivity rather than Compose test-manifest's framework-only theme. */
internal val tableSceneTheme = com.google.android.material.R.style.Theme_Material3_DayNight_NoActionBar

/** Real screen coordinates and attached cell fields for the table placement story. */
internal class TableCellScene(
    private val view: TextFirstEditText,
    private val activity: ComponentActivity,
    private val ui: (() -> Unit) -> Unit,
) {
    private val imeAnimations = mutableSetOf<WindowInsetsAnimationCompat>()
    @Volatile private var imeAnimating = false
    init {
        ui {
            ViewCompat.setWindowInsetsAnimationCallback(view, object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                override fun onPrepare(animation: WindowInsetsAnimationCompat) {
                    if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) imeAnimations += animation
                    imeAnimating = imeAnimations.isNotEmpty()
                }
                override fun onEnd(animation: WindowInsetsAnimationCompat) {
                    imeAnimations -= animation
                    imeAnimating = imeAnimations.isNotEmpty()
                }
                override fun onProgress(insets: WindowInsetsCompat, running: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat = insets
            })
        }
    }
    fun keyboardIdle(): Boolean = !imeAnimating
    fun queryFocused(): Boolean {
        var focused = false
        ui { focused = activity.currentFocus is com.futo.notes.ui.FindQueryEditText }
        return focused
    }
    private fun fieldIn(root: View): TableCellEditText? = when (root) {
        is TableCellEditText -> root
        is ViewGroup -> (0 until root.childCount).firstNotNullOfOrNull { fieldIn(root.getChildAt(it)) }
        else -> null
    }
    /** UI-thread accessor, including inside an assertion block. */
    fun fieldInWindow(): TableCellEditText? = fieldIn(activity.window.decorView)
    fun field(): TableCellEditText? {
        var field: TableCellEditText? = null
        ui { field = fieldInWindow() }
        return field
    }
    fun pointAt(word: String, column: Int? = null): Pair<Float, Float> {
        var point = 0f to 0f
        ui {
            val at = view.text.toString().indexOf(word).also { assertTrue("$word is rendered", it >= 0) }
            val line = view.layout.getLineForOffset(at)
            val location = IntArray(2).also(view::getLocationOnScreen)
            val x = if (column == null) view.layout.getPrimaryHorizontal(at + 1) else {
                val row = view.editableText.getSpans(at, at, TfTableRow::class.java).single()
                (column + 0.5f) * row.cellWidth - row.scroll.x
            }
            point = location[0] + view.totalPaddingLeft + x to
                location[1] + view.totalPaddingTop +
                (view.layout.getLineTop(line) + view.layout.getLineBottom(line)) / 2f - view.scrollY
        }
        return point
    }
    fun keyboardVisible(): Boolean = androidx.core.view.ViewCompat.getRootWindowInsets(view)
        ?.isVisible(androidx.core.view.WindowInsetsCompat.Type.ime()) == true
    fun connection(): InputConnection {
        lateinit var result: InputConnection
        ui {
            val info = EditorInfo()
            result = checkNotNull(fieldInWindow()).onCreateInputConnection(info)
            assertEquals("a wrapped cell keeps the explicit Done action", EditorInfo.IME_ACTION_DONE, info.imeOptions and EditorInfo.IME_MASK_ACTION)
            assertEquals("Gboard should expose Done rather than a newline", 0, info.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION)
        }
        return result
    }
    fun assertCaretVisible() = ui {
        val field = checkNotNull(fieldInWindow())
        assertEquals("typing ends after the inserted text", field.length(), field.selectionEnd)
        assertEquals(field.selectionStart, field.selectionEnd)
        val layout = field.layout
        val line = layout.getLineForOffset(field.selectionEnd)
        val cell = IntArray(2).also(field::getLocationOnScreen)
        val x = cell[0] + field.totalPaddingLeft + layout.getPrimaryHorizontal(field.selectionEnd) - field.scrollX
        val y = cell[1] + field.totalPaddingTop + layout.getLineBottom(line) - field.scrollY
        val viewport = Rect().also { view.getGlobalVisibleRect(it) }
        assertTrue("the wrapped caret is reachable in the note viewport", viewport.contains(x.toInt(), y.toInt()))
    }
    /** Inspect the actual window pixels, including the field above the table's cached span. */
    fun assertNoFindPaint() {
        lateinit var bitmap: android.graphics.Bitmap
        val copied = java.util.concurrent.CountDownLatch(1)
        var status = -1
        ui {
            val field = checkNotNull(fieldInWindow())
            assertFalse("the query, not the cell selection, owns focus", field.isFocused)
            val at = IntArray(2).also(field::getLocationInWindow)
            bitmap = android.graphics.Bitmap.createBitmap(field.width, field.height, android.graphics.Bitmap.Config.ARGB_8888)
            android.view.PixelCopy.request(activity.window, Rect(at[0], at[1], at[0] + field.width, at[1] + field.height), bitmap,
                { result -> status = result; copied.countDown() }, android.os.Handler(android.os.Looper.getMainLooper()))
        }
        assertTrue("the actual cell window is captured", copied.await(5, java.util.concurrent.TimeUnit.SECONDS))
        assertEquals(android.view.PixelCopy.SUCCESS, status)
        try {
            val pixels = IntArray(bitmap.width * bitmap.height)
            bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
            fun markPixels(active: Boolean): Int {
                val color = androidx.core.graphics.ColorUtils.compositeColors(view.style.findMarkColor(active), view.style.codeBackground)
                // Hardware alpha blending can round a channel one value above ColorUtils' integer floor.
                fun channelNear(a: Int, b: Int) = kotlin.math.abs(a - b) <= 1
                return pixels.count { pixel ->
                    android.graphics.Color.alpha(pixel) == 255 &&
                        channelNear(android.graphics.Color.red(pixel), android.graphics.Color.red(color)) &&
                        channelNear(android.graphics.Color.green(pixel), android.graphics.Color.green(color)) &&
                        channelNear(android.graphics.Color.blue(pixel), android.graphics.Color.blue(color))
                }
            }
            for (active in listOf(true, false)) {
                assertEquals("the open cell omits ${if (active) "current" else "ordinary"} Find marks", 0, markPixels(active))
            }
        } finally { bitmap.recycle() }
    }
    fun assertWrapped() = ui {
        val field = checkNotNull(fieldInWindow())
        assertTrue("an in-place field wraps its cell text like the grid", field.layout.lineCount > 1)
    }
    fun assertPlacement(expected: String) = ui { checkPlacement(expected) }
    private fun checkPlacement(expected: String) {
        val field = checkNotNull(fieldInWindow())
        assertSame("the cell and note keep one native window", view.windowToken, field.windowToken)
        assertEquals(expected, field.text.toString())
        val target = checkNotNull(field.placementTarget(view))
        val row = view.editableText.getSpans(target.rowStart, target.rowStart, TfTableRow::class.java)
            .single { view.editableText.getSpanStart(it) == target.rowStart }
        val line = view.layout.getLineForOffset(target.rowStart)
        val note = IntArray(2).also(view::getLocationOnScreen)
        val cell = IntArray(2).also(field::getLocationOnScreen)
        val left = note[0] + view.totalPaddingLeft + view.layout.getLineLeft(line) +
            target.column * row.cellWidth - row.scroll.x - view.scrollX
        assertEquals("the field follows the painted column", left, cell[0].toFloat(), 1f)
        assertEquals("the field follows the actual row top",
            note[1] + view.totalPaddingTop + view.layout.getLineTop(line) - view.scrollY, cell[1])
        assertEquals("the field has one cell's width", row.cellWidth, field.width.toFloat(), 1f)
        assertEquals("the field has the painted row's height",
            view.layout.getLineBottom(line) - view.layout.getLineTop(line), field.height)
        val visible = Rect().also { assertTrue(field.getGlobalVisibleRect(it)) }
        assertEquals("the whole field is visible", field.width, visible.width())
        val bounds = Rect().also { view.getGlobalVisibleRect(it) }
        assertTrue("the field is within the note viewport", bounds.contains(visible))
        assertTrue("the field owns native focus", field.isFocused)
    }
    /** Observe the actual window draw, after root pre-draw, rather than a manual note bitmap. */
    fun watchPlacementFrames(): () -> Unit {
        var frames = 0
        var firstMismatch: String? = null
        lateinit var observer: android.view.ViewTreeObserver
        val listener = android.view.ViewTreeObserver.OnDrawListener {
            val field = fieldInWindow()
            val target = field?.placementTarget(view)
            if (field != null && target != null && field.isFocused) {
                frames += 1
                try { checkPlacement(field.text.toString()) }
                catch (failure: AssertionError) {
                    if (firstMismatch == null) {
                        firstMismatch = "frame=$frames noteSeq=${view.appliedSeq} cellSeq=${target.viewSeq} row=${target.rowStart} column=${target.column}: ${failure.message}"
                    }
                }
            }
        }
        ui {
            observer = view.rootView.viewTreeObserver
            observer.addOnDrawListener(listener)
        }
        return {
            ui {
                if (observer.isAlive) observer.removeOnDrawListener(listener)
                assertTrue("typing drew real root frames", frames > 0)
                assertNull("cell placement must match its note in every displayed frame", firstMismatch)
            }
        }
    }
    fun drag(from: Pair<Float, Float>, to: Pair<Float, Float>) {
        ui {
            val viewport = Rect().also { view.getGlobalVisibleRect(it) }
            val field = Rect().also { fieldInWindow()?.getGlobalVisibleRect(it) }
            assertTrue("a grid drag starts on visible note content", viewport.contains(from.first.toInt(), from.second.toInt()))
            assertFalse("the grid owns this drag outside the active field", field.contains(from.first.toInt(), from.second.toInt()))
        }
        val down = SystemClock.uptimeMillis()
        for (step in 0..10) {
            val action = when (step) { 0 -> MotionEvent.ACTION_DOWN; 10 -> MotionEvent.ACTION_UP; else -> MotionEvent.ACTION_MOVE }
            val fraction = step / 10f
            val event = MotionEvent.obtain(down, down + step * 20L, action,
                from.first + (to.first - from.first) * fraction,
                from.second + (to.second - from.second) * fraction, 0)
            event.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
            try { InstrumentationRegistry.getInstrumentation().sendPointerSync(event) } finally { event.recycle() }
        }
    }
    fun tap(point: Pair<Float, Float>) {
        val now = SystemClock.uptimeMillis()
        for ((action, time) in listOf(MotionEvent.ACTION_DOWN to now, MotionEvent.ACTION_UP to now + 30)) {
            val event = MotionEvent.obtain(now, time, action, point.first, point.second, 0)
            event.source = android.view.InputDevice.SOURCE_TOUCHSCREEN
            try { InstrumentationRegistry.getInstrumentation().sendPointerSync(event) } finally { event.recycle() }
        }
    }
}
