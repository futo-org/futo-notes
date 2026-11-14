package com.futo.notes.textfirst

import android.text.Editable

/** Editable's convenience edits, each one [replace] call. */
internal abstract class ReplaceEditable : Editable {
    override fun insert(where: Int, text: CharSequence, start: Int, end: Int): Editable = replace(where, where, text, start, end)
    override fun insert(where: Int, text: CharSequence): Editable = replace(where, where, text, 0, text.length)
    override fun delete(st: Int, en: Int): Editable = replace(st, en, "", 0, 0)
    override fun append(text: CharSequence): Editable = replace(length, length, text, 0, text.length)
    override fun append(text: CharSequence, start: Int, end: Int): Editable = replace(length, length, text, start, end)
    override fun append(text: Char): Editable = append(text.toString())
    override fun clear() { replace(0, length, "", 0, 0) }
}
