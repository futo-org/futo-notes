package com.futo.notes.textfirst

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.input.placeCursorAtEnd
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.localization.LocalizedMessage
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbScope
import com.futo.notes.ui.applyTypedTitle
import com.futo.notes.ui.NoteTitleField
import com.futo.notes.ui.TitleFieldState
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The warning under the title. A stripped forbidden character's warning hides after 2 s,
 * as in the WebView editor, since the character never persists; a validation result
 * (dot, length, duplicate, or none) replaces it and stays.
 */
internal class TitleWarning(private val scope: CoroutineScope) {
    var message by mutableStateOf<LocalizedMessage?>(null)
        private set
    private var hide: Job? = null

    fun validate(result: LocalizedMessage?) {
        hide?.cancel()
        message = result
    }

    fun forbiddenCharacter() {
        hide?.cancel()
        message = LocalizedMessage("notes.title.forbiddenCharacter")
        hide = scope.launch { delay(2000); message = null }
    }
}

/** The native editor title and its validation feedback. */
@Composable
internal fun TextFirstTitle(
    titleField: TitleFieldState,
    titleWarning: LocalizedMessage?,
    enabled: Boolean,
    verbsEnabled: Boolean,
    onCommit: suspend () -> Unit,
    onReturn: () -> Unit,
    onTyped: (String, Boolean) -> Unit,
) {
    val localization = LocalLocalization.current
    val c = FutoTheme.colors
    PuppetVerbScope {
        if (!verbsEnabled) emptyList() else listOf(
            PuppetVerb("SetTitle", required = listOf("title"), controls = listOf("notes.untitledPlaceholder")) { arguments ->
                titleField.textState.edit {
                    replace(0, length, arguments.getString("title"))
                    applyTypedTitle(onTyped)
                    placeCursorAtEnd()
                }
                onCommit()
            },
        )
    }
    NoteTitleField(
        enabled = enabled,
        state = titleField.textState,
        placeholder = localization.localizedText("notes.untitledPlaceholder"),
        onReturn = onReturn,
        onTyped = onTyped,
        modifier = Modifier.fillMaxWidth().padding(start = 22.dp, end = 22.dp, top = 4.dp)
            .onFocusChanged { focus -> titleField.focusChanged(focus.isFocused) },
    )
    titleWarning?.let { warning ->
        Text(
            localization.localizedText(warning.path, warning.arguments),
            style = FutoType.caption,
            color = c.danger,
            modifier = Modifier.fillMaxWidth().padding(start = 22.dp, end = 22.dp, top = 2.dp),
        )
    }
}
