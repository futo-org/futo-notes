package com.futo.notes.textfirst

import android.text.style.ParagraphStyle
import android.util.Log
import com.futo.notes.BuildConfig
import java.io.File

/**
 * Debug builds only, and only until the quote-drop report is understood (revert before the MR): the last
 * [KEPT] drops, each with the display text and source before and after, what was lifted and where it went,
 * and an audit of the block spans on the lines around where it landed. Kept in the app's files dir as
 * [FILE_NAME]; each landing logs `DragDropAudit: ok` or `DragDropAudit: MISMATCH <what>`.
 */
internal class DropRecorder(private val view: TextFirstEditText) {
    private var record: StringBuilder? = null
    private var landingAt = -1

    fun dropping(block: LiftedBlock, slot: BlockSlot) {
        if (!BuildConfig.DEBUG) return
        val engine = view.engine ?: return
        val entry = StringBuilder()
        entry.append("=== drop ${java.time.LocalDateTime.now()}\n")
        entry.append("lifted [${block.start},${block.end}) toEnd=${block.toEnd} slot=${slot.offset} end=${slot.end}\n")
        entry.append("--- display before\n").append(view.text.toString()).append('\n')
        record = entry
        landingAt = if (slot.offset <= block.start) slot.offset else slot.offset - (block.end - block.start)
        engine.sourceText { source -> if (record === entry) entry.append("--- source before\n").append(source).append('\n') }
    }

    fun landed() {
        val entry = record ?: return
        record = null
        val engine = view.engine ?: return
        val at = landingAt
        // After the landing's last frame, as the reader sees it.
        view.postDelayed({
            val problems = auditLinesAround(at)
            entry.append("--- display after\n").append(view.text.toString()).append('\n')
            entry.append("--- span audit\n").append(problems.second)
            engine.sourceText { source ->
                entry.append("--- source after\n").append(source).append('\n')
                Log.i(TAG, if (problems.first.isEmpty()) "ok" else "MISMATCH ${problems.first.joinToString("; ")}")
                write(entry.toString())
            }
        }, Slide.SLIDE_MS + 300)
    }

    /** Problems found, and one line per line: its block spans with their ranges. */
    private fun auditLinesAround(offset: Int): Pair<List<String>, String> {
        val e = view.editableText ?: return emptyList<String>() to ""
        val text = e.toString()
        val starts = mutableListOf(0)
        for (i in text.indices) if (text[i] == '\n') starts += i + 1
        val center = starts.indexOfLast { it <= offset.coerceIn(0, text.length) }.coerceAtLeast(0)
        val problems = mutableListOf<String>()
        val out = StringBuilder()
        for (index in (center - LINES_AROUND / 2).coerceAtLeast(0)..(center + LINES_AROUND / 2).coerceAtMost(starts.size - 1)) {
            val a = starts[index]
            val b = starts.getOrNull(index + 1) ?: text.length
            val spans = e.getSpans(a, maxOf(a + 1, b), ParagraphStyle::class.java).filter { it is TfSpan }
                .filter { e.getSpanStart(it) < maxOf(a + 1, b) && e.getSpanEnd(it) > a || e.getSpanStart(it) == a }
            val line = text.substring(a, b).trimEnd('\n')
            out.append("$a '$line' ").append(spans.joinToString(" ") { "${it.javaClass.simpleName}[${e.getSpanStart(it)},${e.getSpanEnd(it)})" }).append('\n')
            for ((i, span) in spans.withIndex()) {
                val s = e.getSpanStart(span)
                val en = e.getSpanEnd(span)
                val name = span.javaClass.simpleName
                if (s != 0 && text[s - 1] != '\n') problems += "$name at $s starts mid-line"
                if (en != text.length && text[en - 1] != '\n' && text[en] != '\n') problems += "$name ending $en ends mid-line"
                for (other in spans.drop(i + 1)) if (other.javaClass == span.javaClass && e.getSpanStart(other) < en && e.getSpanEnd(other) > s) problems += "$name [$s,$en) overlaps [${e.getSpanStart(other)},${e.getSpanEnd(other)}) on '$line'"
            }
            if (spans.any { it is TfQuote } && spans.any { it is TfCodeBlock }) problems += "'$line' has both a quote and a code span"
        }
        return problems.distinct() to out.toString()
    }

    private fun write(entry: String) {
        val file = File(view.context.filesDir, FILE_NAME)
        val kept = (if (file.exists()) file.readText() else "").split(SEPARATOR).filter { it.isNotBlank() }.takeLast(KEPT - 1)
        file.writeText((kept + entry.removePrefix(SEPARATOR)).joinToString("") { SEPARATOR + it })
    }

    private companion object {
        const val TAG = "DragDropAudit"
        const val FILE_NAME = "drop-recorder.txt"
        const val SEPARATOR = "=== drop "
        const val KEPT = 5
        const val LINES_AROUND = 12
    }
}
