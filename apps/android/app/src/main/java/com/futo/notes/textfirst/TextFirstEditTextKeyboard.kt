package com.futo.notes.textfirst

import android.view.inputmethod.InputMethodManager

fun TextFirstEditText.showKeyboard() {
    requestFocus()
    context.getSystemService(InputMethodManager::class.java).showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
}

fun TextFirstEditText.hideKeyboard() {
    context.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(windowToken, 0)
    clearFocus()
}

fun TextFirstEditText.restartKeyboard() {
    context.getSystemService(InputMethodManager::class.java).restartInput(this)
}
