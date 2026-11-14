package com.futo.notes.puppet

import android.view.View
import android.view.ViewGroup
import com.futo.notes.textfirst.TextFirstEditText
import com.futo.notes.textfirst.TfInline
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONObject
import kotlin.coroutines.resume

/** Read existing native state only; never select, commit composition, or checkpoint. */
internal suspend fun nativeEditorState(root: View): JSONObject? {
    val view = findNativeEditor(root) ?: return null
    val engine = view.engine ?: return null
    val editable = view.text
    val viewState = JSONObject()
        .put("text", editable?.take(8192)?.toString().orEmpty())
        .put("truncated", (editable?.length ?: 0) > 8192)
        .put("from", view.selectionStart).put("to", view.selectionEnd)
        .put("appliedSeq", view.appliedSeq)
        .put("runs", JSONArray().apply {
            editable?.getSpans(0, minOf(editable.length, 8192), TfInline::class.java)?.forEach { span ->
                put(JSONObject().put("from", editable.getSpanStart(span)).put("to", editable.getSpanEnd(span))
                    .put("bold", span.bold).put("italic", span.italic)
                    .put("strike", span.strike).put("code", span.code))
            }
        })
    val focused = view.hasFocus()
    return withTimeoutOrNull(3000) {
        suspendCancellableCoroutine<JSONObject> { continuation ->
            val posted = engine.handler.post {
                val result = try {
                    val toolbar = engine.session?.toolbarState()
                    val from = engine.selStart
                    val to = engine.selEnd
                    val display = engine.text
                    JSONObject().put("renderer", "native-text-first").put("note", engine.noteId)
                        .put("focused", focused).put("ready", engine.session != null)
                        .put("source", engine.session?.sourceText() ?: "")
                        .put("docVersion", engine.rev.toString()).put("seq", engine.seq)
                        .put("display", display.take(8192).toString()).put("truncated", display.length > 8192)
                        .put("view", viewState)
                        .put("selection", JSONObject().put("from", from).put("to", to)
                            .put("text", display.subSequence(from, minOf(to, from + 8192)).toString())
                            .put("formats", JSONArray(toolbar?.formats?.map { it.name.lowercase() }.orEmpty())))
                        .put("composition", JSONObject().put("from", engine.mirror.composingStart)
                            .put("to", engine.mirror.composingEnd))
                        .put("toolbar", toolbar?.let {
                            JSONObject().put("heading", it.heading?.toInt() ?: 0).put("quote", it.quote)
                                .put("list", it.list?.name?.lowercase() ?: JSONObject.NULL).put("code", it.code)
                                .put("mixed", it.mixed).put("inlineAllowed", it.inlineAllowed)
                                .put("canIndent", it.canIndent).put("canOutdent", it.canOutdent)
                                .put("canUndo", it.canUndo).put("canRedo", it.canRedo)
                        } ?: JSONObject.NULL)
                } catch (e: Exception) {
                    JSONObject().put("error", e.message ?: e.javaClass.simpleName)
                }
                if (continuation.isActive) continuation.resume(result)
            }
            // Navigation can close the editor between finding its view and posting.
            if (!posted && continuation.isActive) {
                continuation.resume(JSONObject().put("ready", false).put("closed", true))
            }
        }
    } ?: JSONObject().put("error", "native editor state did not answer within 3 s")
}

internal fun findNativeEditor(view: View): TextFirstEditText? {
    if (!view.isShown) return null
    if (view is TextFirstEditText) return view
    if (view is ViewGroup) for (index in 0 until view.childCount) {
        findNativeEditor(view.getChildAt(index))?.let { return it }
    }
    return null
}
