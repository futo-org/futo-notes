package com.futo.notes.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldBuffer
import androidx.compose.foundation.text.input.TextFieldDecorator
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
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
 * What the note's title field shows [list.md]. [textState] holds its text and
 * selection; typing reaches it through [NoteTitleField]'s filter. While it is
 * focused only the user's typing changes its text: a title the app commits
 * meanwhile (a rename that trimmed or suffixed what was typed, a move, a sync
 * rename, a conflict copy) waits and shows once the field loses focus. Typing
 * first discards it — the typed text commits on its own debounce.
 */
@Stable
internal class TitleFieldState(title: String) {
    val textState = TextFieldState(title, initialSelection = TextRange.Zero)

    val text: String get() = textState.text.toString()

    var isFocused by mutableStateOf(false)
        private set

    /** A title committed while focused, and the text it was committed for. */
    private var titleOnBlur: Pair<String, String>? = null

    fun focusChanged(focused: Boolean) {
        isFocused = focused
        if (focused) return
        val (title, committedFor) = titleOnBlur ?: return
        titleOnBlur = null
        if (text == committedFor) commit(title)
    }

    fun commit(title: String) {
        when {
            isFocused -> titleOnBlur = title to text
            text != title -> textState.setTextAndPlaceCursorAtEnd(title)
        }
    }

    /** Selects the whole title, so the next keystroke replaces it. */
    fun selectAll() = textState.edit { selection = TextRange(0, length) }
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
 * [filteredTitleInput] applied to an edit in place. It runs inside the field's
 * editing pipeline, so a stripped char never restarts the keyboard's input
 * connection; a restart dropped the next key typed right after one.
 */
internal fun TextFieldBuffer.filterTitleInput() {
    val typed = TextFieldValue(toString(), selection)
    val kept = filteredTitleInput(typed)
    if (kept.text == typed.text) return
    replace(0, length, kept.text)
    selection = kept.selection
}

/**
 * The note's inline title field [list.md]. Return moves on into the body: the
 * keyboard's action key (shown as "next") and a hardware Enter both run
 * [onReturn], and the title never takes a newline. Each edit is filtered
 * ([filterTitleInput]) and then reported to [onTyped] with the filtered title
 * and whether the edit held a forbidden char. The caller owns the rename, so
 * whatever [state] last held still commits on its own debounce.
 */
@Composable
internal fun NoteTitleField(
    state: TextFieldState,
    onTyped: (title: String, forbidden: Boolean) -> Unit,
    placeholder: String,
    enabled: Boolean,
    onReturn: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = FutoTheme.colors
    val currentOnTyped by rememberUpdatedState(onTyped)
    val filter = remember {
        InputTransformation {
            val forbidden = TitleSpec.forbiddenChars.containsMatchIn(toString().replace("\n", ""))
            filterTitleInput()
            currentOnTyped(toString(), forbidden)
        }
    }
    BasicTextField(
        state = state,
        enabled = enabled,
        inputTransformation = filter,
        lineLimits = TextFieldLineLimits.SingleLine,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
        onKeyboardAction = { onReturn() },
        textStyle = FutoType.h3.copy(fontWeight = FontWeight.SemiBold, color = c.textPrimary),
        cursorBrush = SolidColor(c.accent),
        // A hardware Enter is a key event, not an IME action. Both halves of the
        // press are consumed so neither reaches the field.
        modifier = modifier.onPreviewKeyEvent { event ->
            val isEnter = event.key == Key.Enter || event.key == Key.NumPadEnter
            if (isEnter && event.type == KeyEventType.KeyDown) onReturn()
            isEnter
        },
        decorator = TextFieldDecorator { inner ->
            Box {
                if (state.text.isEmpty()) {
                    Text(
                        placeholder,
                        style = FutoType.h3.copy(fontWeight = FontWeight.SemiBold),
                        color = c.textMuted,
                    )
                }
                inner()
            }
        },
    )
}
