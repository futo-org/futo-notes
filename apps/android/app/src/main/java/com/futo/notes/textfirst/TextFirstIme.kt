package com.futo.notes.textfirst

import android.os.Bundle
import android.text.InputType
import android.text.TextUtils
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.core.view.inputmethod.EditorInfoCompat

/** Build only the capabilities our worker connection supports, without creating TextView's IC. */
internal fun TextFirstEditText.createEngineInputConnection(info: EditorInfo, code: Boolean): InputConnection? {
    if (!isEnabled) return null
    val owner = engine ?: return null
    val state = owner.publishedIme ?: return null
    populateEngineEditorInfo(info, state, code)
    return engineInputConnection(owner, this)
}

internal fun TextFirstEditText.populateEngineEditorInfo(info: EditorInfo, state: EngineImeState, code: Boolean) {
    info.inputType = inputType
    if (code) info.inputType = (info.inputType and
        (InputType.TYPE_TEXT_FLAG_AUTO_CORRECT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES).inv()) or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    info.imeOptions = imeOptions or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_ENTER_ACTION
    if (info.imeOptions and EditorInfo.IME_MASK_ACTION == EditorInfo.IME_ACTION_UNSPECIFIED) info.imeOptions = info.imeOptions or EditorInfo.IME_ACTION_DONE
    info.privateImeOptions = privateImeOptions
    info.actionLabel = imeActionLabel
    info.actionId = imeActionId
    info.extras = getInputExtras(false)?.let(::Bundle)
    info.hintLocales = imeHintLocales
    info.hintText = hint
    info.initialSelStart = state.selectionStart
    info.initialSelEnd = state.selectionEnd
    info.initialCapsMode = state.capsModes and info.inputType and IME_CAPS_MODES
    val context = state.context
    // A prefix which omits part of a selected range would lie to the keyboard.
    EditorInfoCompat.setInitialSurroundingSubText(info, context?.text ?: "", context?.start ?: 0)
    EditorInfoCompat.setContentMimeTypes(info, arrayOf("image/*"))
}

internal const val IME_CAPS_MODES = TextUtils.CAP_MODE_CHARACTERS or TextUtils.CAP_MODE_WORDS or TextUtils.CAP_MODE_SENTENCES

/** TextView paints a clipped selection; only this publisher reports coordinates to the IME. */
internal class NativeImePublisher(private val view: TextFirstEditText) {
    private var connectedOwner: EditorEngine? = null

    fun release() { connectedOwner = null }

    fun publish(state: EngineImeState) {
        val owner = view.engine ?: return
        if (owner.publishedIme !== state) return // a newer source state or attachment superseded it
        val firstReady = connectedOwner !== owner
        connectedOwner = owner
        if (!view.isFocused) return
        val manager = view.context.getSystemService(InputMethodManager::class.java)
        // A focused view may have requested a connection while its source was loading.
        if (firstReady) manager.restartInput(view)
        manager.updateSelection(view, state.selectionStart, state.selectionEnd, state.composingStart, state.composingEnd)
    }
}
