package com.futo.notes.ui

import android.content.Context
import android.text.Editable
import android.text.TextWatcher
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.view.KeyEvent
import android.widget.EditText
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.Icons
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.PuppetHostedField
import com.futo.notes.puppet.puppetHostedField
import com.futo.notes.puppet.puppetSection
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

internal class FindQueryEditText(context: Context) : EditText(context) {
    var onQueryChange: (String) -> Unit = {}
    var onStep: (Int) -> Unit = {}
    var onClose: () -> Unit = {}
    private var applyingQuery = false

    init {
        isSingleLine = true
        // hint/contentDescription are catalog-resolved by the composable, in
        // `update` as well as `factory`, so an interface-language change
        // re-labels a bar that is already on screen.
        imeOptions = EditorInfo.IME_ACTION_SEARCH
        addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                if (!applyingQuery) onQueryChange(s?.toString().orEmpty())
            }
            override fun afterTextChanged(s: Editable?) = Unit
        })
        setOnEditorActionListener { _, actionId, event ->
            if (actionId == EditorInfo.IME_ACTION_SEARCH) {
                onStep(1)
                true
            } else if (event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN) {
                onStep(if (event.isShiftPressed) -1 else 1)
                true
            } else {
                false
            }
        }
    }

    fun applyQuery(query: String) {
        if (text.toString() == query) return
        applyingQuery = true
        setText(query)
        setSelection(query.length)
        applyingQuery = false
    }

    override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && event.action == KeyEvent.ACTION_UP) {
            onClose()
            return true
        }
        return super.onKeyPreIme(keyCode, event)
    }
}

@Composable
internal fun FindInNoteBar(
    query: String,
    label: String,
    total: Int,
    onQueryChange: (String) -> Unit,
    onStep: (Int) -> Unit,
    onClose: () -> Unit,
) {
    val c = FutoTheme.colors
    val context = LocalContext.current
    val localization = LocalLocalization.current
    val queryHint = localization.localizedText("editor.find.queryHint")
    val queryLabel = localization.localizedText("editor.find.queryLabel")
    val queryField = remember { arrayOfNulls<FindQueryEditText>(1) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(c.surface)
            .puppetSection("bottom bar"),
    ) {
        HorizontalDivider(thickness = 0.5.dp, color = c.border)
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp)
                .padding(start = 16.dp, end = 4.dp),
        ) {
            AndroidView(
                factory = {
                    FindQueryEditText(context).apply {
                        queryField[0] = this
                        background = null
                        hint = queryHint
                        contentDescription = queryLabel
                        setPadding(0, 0, 0, 0)
                        setTextColor(c.textPrimary.toArgb())
                        setHintTextColor(c.textMuted.toArgb())
                        textSize = 18f
                        includeFontPadding = false
                        this.onQueryChange = onQueryChange
                        this.onStep = onStep
                        this.onClose = onClose
                        applyQuery(query)
                        requestFocus()
                        // The AndroidView can own focus before its window is
                        // ready for IME attachment. Let the composed frame
                        // settle, then repeat focus + show as one operation.
                        postDelayed({
                            requestFocus()
                            context.getSystemService(InputMethodManager::class.java)
                                ?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
                            ViewCompat.getWindowInsetsController(this)
                                ?.show(WindowInsetsCompat.Type.ime())
                        }, 150)
                    }
                },
                update = { field ->
                    field.hint = queryHint
                    field.contentDescription = queryLabel
                    field.onQueryChange = onQueryChange
                    field.onStep = onStep
                    field.onClose = onClose
                    field.setTextColor(c.textPrimary.toArgb())
                    field.setHintTextColor(c.textMuted.toArgb())
                    field.applyQuery(query)
                },
                modifier = Modifier
                    .height(55.dp)
                    .weight(1f)
                    .puppetHostedField {
                        queryField[0]?.let {
                            PuppetHostedField(it.text.toString(), it.contentDescription?.toString(), it.isFocused)
                        }
                    },
            )

            Text(
                label,
                style = FutoType.body,
                color = if (query.isNotEmpty() && total == 0) c.danger else c.textSecondary,
                modifier = Modifier.padding(horizontal = 12.dp),
            )

            VerticalDivider(
                thickness = 0.5.dp,
                color = c.border,
                modifier = Modifier.height(36.dp),
            )

            IconButton(
                enabled = canStepFind(total),
                onClick = { onStep(-1) },
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    Icons.Filled.KeyboardArrowUp,
                    contentDescription = localization.localizedText("editor.find.previousMatch"),
                    tint = if (canStepFind(total)) c.textSecondary else c.textMuted,
                )
            }
            IconButton(
                enabled = canStepFind(total),
                onClick = { onStep(1) },
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    Icons.Filled.KeyboardArrowDown,
                    contentDescription = localization.localizedText("editor.find.nextMatch"),
                    tint = if (canStepFind(total)) c.textSecondary else c.textMuted,
                )
            }
            IconButton(
                onClick = onClose,
                modifier = Modifier.size(48.dp),
            ) {
                Icon(
                    Icons.Filled.Close,
                    contentDescription = localization.localizedText("editor.find.close"),
                    tint = c.textPrimary,
                    modifier = Modifier.size(26.dp),
                )
            }
        }
    }
}
