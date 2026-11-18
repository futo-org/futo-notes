package com.futo.notes.textfirst

import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Enter in the middle of a code block, from the key handed to the input connection to the frame that draws it, in a
 * 120-line and a 2,000-line block. Run with `-Pandroid.testInstrumentationRunnerArguments.codeEnterBench=true`;
 * the medians go to logcat under `CodeEnterBench`.
 */
class TextFirstCodeEnterBenchmarkTest {
    private fun block(lines: Int) = "intro\n\n```txt\n" + (1..lines).joinToString("\n") { "code line $it with some text" } + "\n```\n\nend"

    private fun measure(lines: Int) = textFirstSession(block(lines)) { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        withTimeout(10_000) { while (view.layout == null) delay(20) }
        val middle = view.editableText.indexOf("code line ${lines / 2} ") + "code line ${lines / 2}".length
        c.select(middle)
        withTimeout(5_000) { while (view.selectionStart != middle) delay(20) }
        delay(500)
        val connection = view.onCreateInputConnection(EditorInfo())!!
        val times = mutableListOf<Long>()
        repeat(25) { index ->
            val drawn = CompletableDeferred<Long>()
            view.onFrameDrawn = { drawn.complete(SystemClock.elapsedRealtimeNanos()) }
            val start = SystemClock.elapsedRealtimeNanos()
            connection.handler!!.post { connection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)) }
            val end = withTimeout(10_000) { drawn.await() }
            if (index >= 5) times.add(end - start)
            delay(150)
        }
        times.sort()
        Log.i("CodeEnterBench", "lines=$lines median=${times[times.size / 2] / 1_000_000.0}ms max=${times.last() / 1_000_000.0}ms")
    }

    @Test fun enterInABlock() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("codeEnterBench") == "true")
        measure(120)
        measure(2000)
    }
}
