package com.futo.notes.textfirst

import android.text.InputFilter

/** A language is one token: a space becomes a hyphen, and a leading one is dropped (!300 cb 371-373). */
internal val languageFilter = InputFilter { source, start, end, _, dstart, _ ->
    val typed = source.subSequence(start, end).toString()
    if (' ' !in typed) return@InputFilter null
    val hyphenated = typed.replace(' ', '-')
    if (dstart == 0) hyphenated.trimStart('-') else hyphenated
}
