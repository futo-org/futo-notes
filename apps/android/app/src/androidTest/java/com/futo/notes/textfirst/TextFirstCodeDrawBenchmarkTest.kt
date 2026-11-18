package com.futo.notes.textfirst

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Debug
import android.os.SystemClock
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * One frame of a screen of code blocks with a selection in one of them: the objects it allocates and the time it
 * takes. Run with `-Pandroid.testInstrumentationRunnerArguments.codeDrawBench=true`; results go to logcat under
 * `CodeDrawBench`.
 */
class TextFirstCodeDrawBenchmarkTest {
    private val note = (1..6).joinToString("\n\n") { block ->
        "```js name:file-$block.js\n" + (1..6).joinToString("\n") { "const line$it = $block * $it // a comment that is long" } + "\n```"
    } + "\n\nend"

    @Test fun drawAScreenOfBlocks() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("codeDrawBench") == "true")
        measure("blocks", note)
        measure("plain", note.lines().filterNot { it.startsWith("```") }.joinToString("\n"))
    }

    @Suppress("DEPRECATION")
    private fun measure(label: String, note: String) {
        textFirstSession(note) { c ->
            val view = c.view
            view.isFocusableInTouchMode = true
            view.requestFocus()
            withTimeout(10_000) { while (view.layout == null) delay(20) }
            val at = view.editableText.indexOf("line3 = 2")
            c.select(at, at + 12)
            withTimeout(5_000) { while (view.selectionEnd != at + 12) delay(20) }
            delay(500)
            val canvas = Canvas(Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888))
            repeat(50) { view.draw(canvas) }
            val frames = 300
            Debug.startAllocCounting()
            Debug.resetGlobalAllocCount()
            val start = SystemClock.elapsedRealtimeNanos()
            repeat(frames) { view.draw(canvas) }
            val elapsed = SystemClock.elapsedRealtimeNanos() - start
            val allocations = Debug.getGlobalAllocCount()
            Debug.stopAllocCounting()
            Log.i("CodeDrawBench", "$label allocations/frame=${allocations / frames} time/frame=${elapsed / frames / 1000}us")
            Debug.startAllocCounting()
            Debug.resetGlobalAllocCount()
            val chromeStart = SystemClock.elapsedRealtimeNanos()
            repeat(frames) { view.drawCodeBlocks(canvas); view.drawCodeSelection(canvas); view.drawFindMarks(canvas) }
            val chromeElapsed = SystemClock.elapsedRealtimeNanos() - chromeStart
            val chromeAllocations = Debug.getGlobalAllocCount()
            Debug.stopAllocCounting()
            Log.i("CodeDrawBench", "$label chrome allocations/frame=${chromeAllocations / frames} time/frame=${chromeElapsed / frames / 1000}us")
        }
    }
}
