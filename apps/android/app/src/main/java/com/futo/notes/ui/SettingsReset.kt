package com.futo.notes.ui

import androidx.activity.compose.BackHandler
import com.futo.notes.ui.settings.appicon.AppIconController
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.futo.notes.NotesStore
import com.futo.notes.SyncManager
import com.futo.notes.license.LicenseModel
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import com.futo.notes.disconnectForReset
import com.futo.notes.finishReset

/**
 * Full reset [settings.md]: close writer admission, join sync and discard its
 * stored credential, then drain old work before wiping the vault. Failures are
 * shown through [toast] as catalog paths.
 */
internal suspend fun fullReset(
    store: NotesStore,
    sync: SyncManager,
    license: LicenseModel,
    appIcons: AppIconController,
    toast: (String) -> Unit,
) {
    store.suppressAutoPush = true
    try {
        withContext(NonCancellable) {
            store.deleteAll { sync.disconnectForReset() }
            // The license is a preference, and Full reset wipes preferences
            // (docs/spec/license.md § Storage). Last, because it touches nothing
            // the step above needs — and silently, since the user is already
            // looking at the result of a reset. A throwing deleteAll skips it:
            // nothing was wiped.
            license.clearForFullReset()
            try { appIcons.reset() } catch (_: Exception) { toast("settings.appIcon.resetFailed") }
        }
    } catch (e: Exception) {
        toast("settings.danger.failed")
    } finally {
        sync.finishReset()
        store.suppressAutoPush = false
    }
}

/**
 * Blocking overlay — swallows every tap AND Back while the vault is wiped;
 * Back would otherwise leave Settings mid-delete.
 */
@Composable
internal fun ResettingOverlay() {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    BackHandler {}
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.surfaceInverse.copy(alpha = 0.45f))
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
        contentAlignment = Alignment.Center,
    ) {
        Surface(color = c.surface, shape = RoundedCornerShape(FutoRadius.md)) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(20.dp)) {
                CircularProgressIndicator(color = c.accent, strokeWidth = 2.5.dp, modifier = Modifier.size(22.dp))
                Spacer(Modifier.width(14.dp))
                Text(
                    localization.localizedText("settings.danger.deleting"),
                    style = FutoType.body,
                    color = c.textPrimary,
                )
            }
        }
    }
}
