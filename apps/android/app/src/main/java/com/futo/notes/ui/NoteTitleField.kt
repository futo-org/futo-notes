package com.futo.notes.ui

import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.TextFieldValue
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/**
 * The title field once a debounced rename has committed [committed]. The rename
 * lands mid-typing whenever the user pauses for 500 ms, so a title it left as
 * typed keeps the field exactly as it is: caret, selection and the keyboard's
 * composing region. A title the rename changed (sanitized, say) puts the caret
 * at its end.
 */
internal fun titleFieldAfterRename(field: TextFieldValue, committed: String): TextFieldValue =
    if (field.text == committed) field else TextFieldValue(committed, TextRange(committed.length))

/**
 * The note's inline title field [list.md]. Return moves on into the body: the
 * keyboard's action key (shown as "next") and a hardware Enter both run
 * [onReturn], and the title never takes a newline. The caller owns the rename,
 * so whatever [onValueChange] last saw still commits on its own debounce.
 */
@Composable
internal fun NoteTitleField(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    placeholder: String,
    enabled: Boolean,
    onReturn: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = FutoTheme.colors
    BasicTextField(
        enabled = enabled,
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
        keyboardActions = KeyboardActions(onNext = { onReturn() }),
        textStyle = FutoType.h3.copy(fontWeight = FontWeight.SemiBold, color = c.textPrimary),
        cursorBrush = SolidColor(c.accent),
        // A hardware Enter is a key event, not an IME action. Both halves of the
        // press are consumed so neither reaches the field.
        modifier = modifier.onPreviewKeyEvent { event ->
            val isEnter = event.key == Key.Enter || event.key == Key.NumPadEnter
            if (isEnter && event.type == KeyEventType.KeyDown) onReturn()
            isEnter
        },
        decorationBox = { inner ->
            if (value.text.isEmpty()) {
                Text(
                    placeholder,
                    style = FutoType.h3.copy(fontWeight = FontWeight.SemiBold),
                    color = c.textMuted,
                )
            }
            inner()
        },
    )
}
