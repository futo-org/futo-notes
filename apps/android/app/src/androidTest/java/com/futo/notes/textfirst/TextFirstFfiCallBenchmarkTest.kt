package com.futo.notes.textfirst

import android.os.Handler
import android.os.HandlerThread
import android.os.Process
import android.os.SystemClock
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assume.assumeTrue
import org.junit.Test
import uniffi.futo_notes_ffi.EditorByteRange
import uniffi.futo_notes_ffi.EditorInputAction
import uniffi.futo_notes_ffi.EditorParagraphKey
import uniffi.futo_notes_ffi.EditorUtf16Range
import uniffi.futo_notes_ffi.NoteStore

/**
 * What one call into the Rust engine costs through the generated bindings,
 * apart from the engine's own work: cheap calls timed on a display-priority
 * thread like the editor's. Logged under TextFirstFfi. Opt-in:
 * `-e textFirstFfiBench true`.
 */
class TextFirstFfiCallBenchmarkTest {
    @Test
    fun timeCheapCalls() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("textFirstFfiBench") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val vault = File(context.cacheDir, "tf-ffi-bench").apply { deleteRecursively(); check(mkdirs()) }
        val store = NoteStore(vault.absolutePath)
        val id = store.createNote("ffi", "", SMALL_NOTE).finalId!!
        val session = store.openEditor(id)
        val thread = HandlerThread("ffi-bench", Process.THREAD_PRIORITY_DISPLAY).apply { start() }
        val done = CountDownLatch(1)
        Handler(thread.looper).post {
            fun time(name: String, block: () -> Unit) {
                repeat(200) { block() }
                val n = 2000
                val start = SystemClock.elapsedRealtimeNanos()
                repeat(n) { block() }
                val us = (SystemClock.elapsedRealtimeNanos() - start) / n / 1000.0
                android.util.Log.i("TextFirstFfi", "$name: ${"%.1f".format(us)} µs/call")
            }
            val rev = session.revision()
            time("revision()") { session.revision() }
            time("activeFormats()") { session.activeFormats() }
            time("project(rev, 0..0)") { session.project(rev, EditorByteRange(0u, 0u)) }
            // A typed key and its Backspace at the middle line's end, as the editor sends them.
            val text = session.displayText()
            val at = text.indexOf('\n', text.length / 2).toULong()
            time("type + backspace") {
                session.replaceUtf16Action(session.revision(), EditorUtf16Range(at, at), listOf('a'.code.toUShort()), EditorInputAction.TYPING)
                session.paragraphKeyUtf16(session.revision(), EditorUtf16Range(at + 1u, at + 1u), EditorParagraphKey.BACKSPACE)
            }
            // The same keys with typing's idle gaps: does an idle CPU make each key slower?
            val idle = LongArray(200)
            for (i in idle.indices) {
                SystemClock.sleep(20)
                val t0 = SystemClock.elapsedRealtimeNanos()
                session.replaceUtf16Action(session.revision(), EditorUtf16Range(at, at), listOf('a'.code.toUShort()), EditorInputAction.TYPING)
                session.paragraphKeyUtf16(session.revision(), EditorUtf16Range(at + 1u, at + 1u), EditorParagraphKey.BACKSPACE)
                idle[i] = SystemClock.elapsedRealtimeNanos() - t0
            }
            idle.sort()
            android.util.Log.i("TextFirstFfi", "type + backspace after 20 ms idle: p50 ${idle[100] / 1000} µs, p95 ${idle[190] / 1000} µs")
            // The same, inside an ADPF hint session that reports each key's work.
            val hints = context.getSystemService(android.os.PerformanceHintManager::class.java)
            val hint = hints?.createHintSession(intArrayOf(Process.myTid()), 4_000_000L)
            android.util.Log.i("TextFirstFfi", "hint session: ${hint != null}, preferred rate ${hints?.preferredUpdateRateNanos}")
            if (hint != null) {
                for (i in idle.indices) {
                    SystemClock.sleep(20)
                    val t0 = SystemClock.elapsedRealtimeNanos()
                    session.replaceUtf16Action(session.revision(), EditorUtf16Range(at, at), listOf('a'.code.toUShort()), EditorInputAction.TYPING)
                    session.paragraphKeyUtf16(session.revision(), EditorUtf16Range(at + 1u, at + 1u), EditorParagraphKey.BACKSPACE)
                    idle[i] = SystemClock.elapsedRealtimeNanos() - t0
                    hint.reportActualWorkDuration(idle[i])
                }
                idle.sort()
                android.util.Log.i("TextFirstFfi", "with hint session: p50 ${idle[100] / 1000} µs, p95 ${idle[190] / 1000} µs")
                hint.close()
            }
            done.countDown()
        }
        check(done.await(120, TimeUnit.SECONDS))
        thread.quitSafely()
        session.detach()
        store.destroy()
        vault.deleteRecursively()
    }

    private companion object {
        /** A typical ~1.2k-char note: headings, a list, a link, plain lines. */
        const val SMALL_NOTE = """# Weekly plan

Things to get done before Friday, roughly in order.

- call the **bank** about the transfer
- book the [dentist](https://example.com/dentist) for next month
- pick up the dry cleaning
- reply to Sam about the cabin weekend

## Notes from Monday

The meeting ran long. We agreed to move the launch to the 14th and to
cut the onboarding survey down to three questions. Alex will draft them.

1. send the revised timeline
2. update the *budget* sheet
3. ask legal about the new terms

## Groceries

- eggs
- oat milk
- coffee beans
- something for dinner on Thursday

> Remember: the car needs an oil change soon.
"""
    }
}
