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
 * What the note's title field shows [list.md]. While it is focused only the
 * user's typing changes its text: a title the app commits meanwhile (a rename
 * that trimmed or suffixed what was typed, a move, a sync rename, a conflict
 * copy) waits in [titleOnBlur] and shows once the field loses focus. Typing
 * first discards it — the typed text commits on its own debounce.
 */
internal data class TitleFieldState(
    val value: TextFieldValue,
    val isFocused: Boolean = false,
    val titleOnBlur: String? = null,
) {
    fun afterTyping(edited: TextFieldValue) = copy(
        value = edited,
        titleOnBlur = titleOnBlur.takeIf { edited.text == value.text },
    )

    fun afterFocusChange(focused: Boolean): TitleFieldState {
        val changed = copy(isFocused = focused)
        if (focused || titleOnBlur == null) return changed
        return changed.copy(titleOnBlur = null).afterCommit(titleOnBlur)
    }

    fun afterCommit(title: String): TitleFieldState = when {
        isFocused -> copy(titleOnBlur = title)
        value.text == title -> this
        else -> copy(value = TextFieldValue(title, TextRange(title.length)))
    }
}

/**
 * What [typed] leaves in the title field [list.md]: newlines and forbidden
 * filename chars stripped in place, capped at the title length limit. Each
 * selection end lands after the chars that survived before it, so the caret
 * stays where a stripped char was typed instead of moving right past it.
 */
internal fun filteredTitleInput(typed: TextFieldValue): TextFieldValue {
    fun filter(text: String) =
        TitleSpec.forbiddenChars.replace(text.replace("\n", ""), "").take(TitleSpec.maxLength)
    val filtered = filter(typed.text)
    if (filtered == typed.text) return typed
    fun kept(offset: Int) = filter(typed.text.take(offset)).length
    return TextFieldValue(filtered, TextRange(kept(typed.selection.start), kept(typed.selection.end)))
}

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
