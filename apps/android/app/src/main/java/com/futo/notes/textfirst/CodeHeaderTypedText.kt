package com.futo.notes.textfirst

import android.text.Editable

/**
 * Makes [text] what the engine says a header field keeps of it, changing only the part that differs so the caret and a
 * keyboard's composition around it stay. True when it changed [text].
 */
internal fun keepEngineTypedText(text: Editable, kept: String): Boolean {
    val typed = text.toString()
    if (typed == kept) return false
    val prefix = typed.commonPrefixWith(kept).length
    val suffix = typed.substring(prefix).commonSuffixWith(kept.substring(prefix)).length
    text.replace(prefix, typed.length - suffix, kept, prefix, kept.length - suffix)
    return true
}
