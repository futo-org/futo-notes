package com.futo.notes.puppet

import com.futo.notes.textfirst.BlockSlot
import com.futo.notes.textfirst.TextFirstEditText
import com.futo.notes.textfirst.blockSlots
import com.futo.notes.textfirst.finishStreaming
import com.futo.notes.textfirst.liftedBlock
import com.futo.notes.textfirst.moveBlock
import com.futo.notes.textfirst.streaming
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import uniffi.futo_notes_ffi.EditorSessionException

/** `MoveBlock {line, column?, before | after}` as asked: display lines, a UTF-16 column. */
internal class MoveBlockRequest(val line: Int, val column: Int?, val before: Int?, val after: Int?)

/** Read [args]; anything that is not a whole number where one is wanted, or not exactly one of before/after, is a 400. */
internal fun moveBlockRequest(args: JSONObject): MoveBlockRequest {
    fun whole(key: String): Int? {
        if (!args.has(key)) return null
        return when (val raw = args.get(key)) {
            is Int -> raw
            is Long -> raw.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()
            else -> null
        } ?: throw PuppetVerbRefusal(400, "$key ${args.get(key)} is not a whole number")
    }
    val line = whole("line") ?: throw PuppetVerbRefusal(400, "MoveBlock requires line")
    val column = whole("column")
    if (column != null && column < 0) throw PuppetVerbRefusal(400, "column $column is not a UTF-16 column on line $line")
    val before = whole("before")
    val after = whole("after")
    if ((before == null) == (after == null)) throw PuppetVerbRefusal(400, """MoveBlock needs one of {"before":<line>} or {"after":<line>}""")
    return MoveBlockRequest(line, column, before, after)
}

/**
 * What a press at UTF-16 `column` of display line `line` lifts (its start by default; an image
 * there sharing its line lifts alone) dropped at the boundary above `before` or below `after`,
 * through the same engine calls as the long-press drag. The engine decides the block and its
 * slots; a boundary that is not one of them is a 409. Like a lift, it first finishes loading a
 * note still streaming in, so any line of the note may be named (Android has no ScrollToLine).
 */
internal suspend fun moveBlockVerb(view: TextFirstEditText, args: JSONObject): PuppetReply {
    val request = try { moveBlockRequest(args) } catch (refusal: PuppetVerbRefusal) {
        return PuppetContract.refusal(refusal.status, refusal.message)
    }
    val engine = view.engine ?: return PuppetContract.refusal(503, "native editor is not open")
    val answer = onceOnEditorThread(engine.handler::post, 5_000) {
        try { engine.moveBlockOnEditorThread(request) } catch (refusal: PuppetVerbRefusal) {
            refusal.status to refusal.message
        } catch (e: EditorSessionException) {
            409 to "the engine refused the move: $e"
        }
    } ?: return PuppetContract.refusal(503, "MoveBlock: the editor did not start it within 5 s; nothing was done")
    if (answer.first != 200) return PuppetContract.refusal(answer.first, answer.second)
    return PuppetReply(200, JSONObject().put("ok", true).put("moved", JSONObject(answer.second)).toString())
}

/** Editor thread: (200, the receipt's JSON) or a refusal. */
private fun com.futo.notes.textfirst.EditorEngine.moveBlockOnEditorThread(request: MoveBlockRequest): Pair<Int, String> {
    if (session == null || closed) throw PuppetVerbRefusal(503, "native editor is not open")
    // Text being composed is the person's, and the engine refuses a move while it lasts.
    if (mirror.overlay != null) throw PuppetVerbRefusal(409, "text is being composed: commit or cancel it before moving a block")
    if (streaming) finishStreaming()
    val text = mirror.text
    val starts = buildList { add(0); text.forEachIndexed { i, c -> if (c == '\n') add(i + 1) } }
    fun lineRange(number: Int): IntRange {
        if (number < 1 || number > starts.size) throw PuppetVerbRefusal(400, "no line $number in the native document (it has ${starts.size})")
        val start = starts[number - 1]
        val end = if (number < starts.size) starts[number] - 1 else text.length
        return start..end
    }
    val line = lineRange(request.line)
    val column = request.column ?: 0
    // Against the line's length before adding: a huge column must not wrap around.
    if (column > line.last - line.first) throw PuppetVerbRefusal(400, "column $column is not a UTF-16 column on line ${request.line}")
    val at = line.first + column
    if ((at in 1 until text.length && Character.isLowSurrogate(text[at]) && Character.isHighSurrogate(text[at - 1]))) {
        throw PuppetVerbRefusal(400, "column $column is not a UTF-16 column on line ${request.line}")
    }
    val target = request.before ?: request.after!!
    val targetLine = lineRange(target)
    // Above a line is its start; below the last line is the note's end, which an empty last
    // line (an empty task shows no characters) shares with the boundary above it.
    val slot = when {
        request.before != null -> BlockSlot(targetLine.first, false)
        target < starts.size -> BlockSlot(starts[target], false)
        else -> BlockSlot(text.length, true)
    }
    val side = if (request.before != null) "before" else "after"
    liftedBlock(at) ?: throw PuppetVerbRefusal(409, "line ${request.line} lifts nothing: a blank line, front matter and code nothing closes do not move")
    // Only the destination is asked about: a whole note's slots are a trial each.
    if (slot !in blockSlots(at, slot.offset..slot.offset)) throw PuppetVerbRefusal(
        409,
        "line ${request.line}'s block cannot land $side line $target: that boundary is its own edge, or inside a quote, code block, table or front matter, or inside a list that takes only list items and plain lines, or a line would read as another kind of block there",
    )
    if (!moveBlock(at, slot)) throw PuppetVerbRefusal(409, "the editor refused to move line ${request.line}'s block $side line $target: the note changed")
    return 200 to JSONObject().put("line", request.line).put(side, target).toString()
}

/**
 * Run [work] once on the thread [post] reaches and return its result, or null when it had not
 * started within [timeoutMs]: then it never runs, so a refusal for the timeout and a change to
 * the note are never both the answer. Once started it is waited for to the end.
 */
internal suspend fun <T : Any> onceOnEditorThread(post: (Runnable) -> Boolean, timeoutMs: Long, work: () -> T): T? {
    val state = AtomicInteger(PENDING)
    val result = CompletableDeferred<T?>()
    val posted = post(Runnable {
        if (!state.compareAndSet(PENDING, STARTED)) return@Runnable
        result.complete(try { work() } catch (e: Throwable) { result.completeExceptionally(e); return@Runnable })
    })
    if (!posted) return null
    return withTimeoutOrNull(timeoutMs) { result.await() }
        ?: if (state.compareAndSet(PENDING, ABANDONED)) null else result.await()
}

private const val PENDING = 0
private const val STARTED = 1
private const val ABANDONED = 2
