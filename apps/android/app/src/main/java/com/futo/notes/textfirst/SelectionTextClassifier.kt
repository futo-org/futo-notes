package com.futo.notes.textfirst

import android.view.textclassifier.TextClassifier
import android.view.textclassifier.TextSelection
import android.view.textclassifier.TextClassification
import android.view.textclassifier.TextLinks
import android.view.textclassifier.SelectionEvent
import android.view.textclassifier.TextLanguage
import android.view.textclassifier.ConversationActions
import android.view.textclassifier.TextClassifierEvent
import android.os.Build
import androidx.annotation.RequiresApi

internal fun TextFirstEditText.configureSelectionClassifier() {
    // The platform still classifies the selected text for smart actions,
    // but a deferred word suggestion must not replace a newer triple-tap range.
    setTextClassifier(selectionTextClassifier(textClassifier))
}

internal fun selectionTextClassifier(native: TextClassifier): TextClassifier =
    if (Build.VERSION.SDK_INT >= 29) SelectionTextClassifier29(native) else SelectionTextClassifier(native)

/** Keep native smart actions without letting a delayed suggestion replace a newer touch range. */
private open class SelectionTextClassifier(protected val native: TextClassifier) : TextClassifier {
    override fun suggestSelection(request: TextSelection.Request): TextSelection =
        TextSelection.Builder(request.startIndex, request.endIndex).build()

    // TextClassifier's methods have Java defaults: Kotlin interface delegation
    // would inherit those no-op defaults instead of forwarding the smart actions.
    override fun classifyText(request: TextClassification.Request) = native.classifyText(request)
    override fun generateLinks(request: TextLinks.Request) = native.generateLinks(request)
    override fun getMaxGenerateLinksTextLength() = native.maxGenerateLinksTextLength
    override fun onSelectionEvent(event: SelectionEvent) = native.onSelectionEvent(event)
    override fun destroy() = native.destroy()
    override fun isDestroyed() = native.isDestroyed
}

@RequiresApi(29)
private class SelectionTextClassifier29(native: TextClassifier) : SelectionTextClassifier(native) {
    override fun detectLanguage(request: TextLanguage.Request) = native.detectLanguage(request)
    override fun suggestConversationActions(request: ConversationActions.Request) = native.suggestConversationActions(request)
    override fun onTextClassifierEvent(event: TextClassifierEvent) = native.onTextClassifierEvent(event)
}
