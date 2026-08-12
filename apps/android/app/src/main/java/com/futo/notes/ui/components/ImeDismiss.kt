package com.futo.notes.ui.components

import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.imeAnimationTarget
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager

/**
 * Drops focus when the soft keyboard is dismissed by the system back
 * gesture/button — Android hides the IME WITHOUT clearing focus, leaving a
 * functionless caret blinking in whatever field owned the keyboard (#24).
 *
 * Installed once at the app root (MainActivity), which covers every screen in
 * the Activity window; [onDismiss] is the root's hook to also blur the editor
 * WebView, whose DOM caret survives a view-level clearFocus. A Dialog is its
 * OWN window with its own focus manager, so a dialog hosting a text field
 * installs its own copy (NewFolderDialog, CrashReportDialog).
 *
 * [imeVisible] must be [imeTargetVisible] read in the ACTIVITY window — a
 * dialog composable reads it in its function body, not its dialog content. A
 * dialog window's own insets lie: its decor consumes the IME inset, so inside
 * it the reading is 0 with the keyboard up and >0 transiently while the show
 * animation runs — keyed on that, this cleared focus and closed the keyboard
 * as it opened (github#23).
 */
@Composable
fun ClearFocusOnImeDismiss(imeVisible: Boolean, onDismiss: () -> Unit = {}) {
    val focusManager = LocalFocusManager.current
    var wasVisible by remember { mutableStateOf(imeVisible) }
    LaunchedEffect(imeVisible) {
        if (imeJustHid(wasVisible, imeVisible)) {
            focusManager.clearFocus()
            onDismiss()
        }
        wasVisible = imeVisible
    }
}

/**
 * Whether the IME is — or is animating to be — visible, per the insets of the
 * window this composes in: only truthful in the Activity window (github#23).
 * `imeAnimationTarget` flips to the end state the moment the hide animation
 * STARTS; gating on the live `ime` inset (isImeVisible) would leave the caret
 * up through the whole slide-down, which reads as lag.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun imeTargetVisible(): Boolean =
    WindowInsets.imeAnimationTarget.getBottom(LocalDensity.current) > 0

/** The IME visible→hidden transition — the moment a lingering caret must drop. */
internal fun imeJustHid(wasImeVisible: Boolean, imeVisible: Boolean): Boolean =
    wasImeVisible && !imeVisible
