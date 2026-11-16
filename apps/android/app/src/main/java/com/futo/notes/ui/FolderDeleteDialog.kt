package com.futo.notes.ui

import android.os.Build
import android.provider.Settings
import android.view.HapticFeedbackConstants
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material3.BasicAlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.lifecycleScope
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbRefusal
import com.futo.notes.puppet.PuppetVerbScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** How long "Delete all" stays disabled after step 2 shows, so a double-tap on step 1's
 *  "Delete folder and notes…" cannot reach it [folder-management.md]. */
internal const val FOLDER_DELETE_ARM_MS = 600L

private const val LISTED_TITLES = 3

/** The system animator scale is zero when a person asked for no unrequested motion. */
@Composable
internal fun rememberAnimatorsEnabled(): Boolean {
    val context = LocalContext.current
    return remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) != 0f
    }
}

/**
 * The delete-a-folder dialog for a folder that has notes [folder-management.md]. Step 1
 * asks whether its notes are kept; "Delete folder and notes…" turns the SAME dialog, in
 * place, into step 2, which lists what will be lost. Step 2's "Delete all" is armed
 * [FOLDER_DELETE_ARM_MS] after it appears and sits at the bottom, far from where step 1's
 * button was. [onFolderOnly] and [onDeleteAll] are the whole act: a puppet verb answers
 * once it has finished.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun FolderDeleteDialog(
    folderName: String,
    noteTitles: List<String>,
    onCancel: () -> Unit,
    onFolderOnly: suspend () -> Unit,
    onDeleteAll: suspend () -> Unit,
) {
    val localization = LocalLocalization.current
    val colors = MaterialTheme.colorScheme
    val view = LocalView.current
    val scope = LocalLifecycleOwner.current.lifecycleScope
    val animates = rememberAnimatorsEnabled()
    val count = noteTitles.size
    var step by remember { mutableStateOf(1) }
    var armed by remember { mutableStateOf(false) }

    LaunchedEffect(step) {
        armed = false
        if (step != 2) return@LaunchedEffect
        view.performHapticFeedback(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) HapticFeedbackConstants.REJECT
            else HapticFeedbackConstants.LONG_PRESS,
        )
        delay(FOLDER_DELETE_ARM_MS)
        armed = true
    }

    // While it is up it is all a person can reach.
    PuppetVerbScope(modal = true) {
        if (step == 1) {
            listOf(
                PuppetVerb("DeleteFolderOnly", controls = listOf("folders.delete.folderOnly")) {
                    onFolderOnly()
                    mapOf("deleted" to "folder", "keptNotes" to count)
                },
                PuppetVerb("DeleteFolderAndNotes", controls = listOf("folders.delete.folderAndNotes")) {
                    step = 2
                    mapOf("step" to 2, "notes" to count)
                },
                PuppetVerb("DismissDialog", controls = listOf("common.actions.cancel")) { onCancel() },
            )
        } else {
            listOf(
                PuppetVerb("DeleteAllNotes", controls = listOf("folders.delete.deleteAll")) {
                    if (!armed) throw PuppetVerbRefusal(409, "Delete all is not armed yet; retry in 0.6 s")
                    onDeleteAll()
                    mapOf("deleted" to "folder and notes", "deletedNotes" to count)
                },
                PuppetVerb("BackToChoice", controls = listOf("common.actions.back")) {
                    step = 1
                    mapOf("step" to 1)
                },
            )
        }
    }

    BasicAlertDialog(onDismissRequest = onCancel) {
        Surface(
            shape = RoundedCornerShape(28.dp),
            color = colors.surfaceContainerHigh,
            modifier = Modifier.sizeIn(minWidth = 280.dp, maxWidth = 560.dp),
        ) {
            AnimatedContent(
                targetState = step,
                label = "folder-delete-step",
                transitionSpec = {
                    val fade = if (animates) 180 else 90
                    (fadeIn(tween(fade, delayMillis = fade / 2)) togetherWith fadeOut(tween(fade / 2)))
                        .using(
                            SizeTransform(clip = true) { _, _ ->
                                if (animates) tween(280) else snap()
                            },
                        )
                },
            ) { shown ->
                Column(
                    Modifier
                        .verticalScroll(rememberScrollState())
                        .padding(24.dp),
                ) {
                    if (shown == 1) {
                        val name = folderName
                        Text(
                            localization.localizedText("folders.delete.namedTitle", mapOf("folderName" to name)),
                            style = MaterialTheme.typography.headlineSmall,
                            color = colors.onSurface,
                            modifier = Modifier.semantics { heading() },
                        )
                        Spacer(Modifier.height(16.dp))
                        Text(
                            localization.localizedText("folders.delete.keptNotesMessage", mapOf("count" to count.toLong())),
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(24.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilledTonalButton(
                                onClick = { scope.launch { onFolderOnly() } },
                                colors = ButtonDefaults.filledTonalButtonColors(
                                    containerColor = colors.primaryContainer,
                                    contentColor = colors.onPrimaryContainer,
                                ),
                                modifier = Modifier.fillMaxWidth().testTag("folder-delete-only"),
                            ) { Text(localization.localizedText("folders.delete.folderOnly")) }
                            OutlinedButton(
                                onClick = { step = 2 },
                                colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.error),
                                border = BorderStroke(1.dp, colors.error.copy(alpha = 0.5f)),
                                modifier = Modifier.fillMaxWidth().testTag("folder-delete-and-notes"),
                            ) { Text(localization.localizedText("folders.delete.folderAndNotes")) }
                            TextButton(
                                onClick = onCancel,
                                modifier = Modifier.fillMaxWidth().testTag("folder-delete-cancel"),
                            ) { Text(localization.localizedText("common.actions.cancel")) }
                        }
                    } else {
                        Icon(
                            Icons.Filled.Delete,
                            contentDescription = null,
                            tint = colors.error,
                            modifier = Modifier.align(Alignment.CenterHorizontally).size(24.dp),
                        )
                        Spacer(Modifier.height(16.dp))
                        Text(
                            localization.localizedText("folders.delete.notesTitle", mapOf("count" to count.toLong())),
                            style = MaterialTheme.typography.headlineSmall,
                            color = colors.onSurface,
                            textAlign = TextAlign.Center,
                            modifier = Modifier
                                .fillMaxWidth()
                                .semantics {
                                    heading()
                                    liveRegion = LiveRegionMode.Polite
                                },
                        )
                        Spacer(Modifier.height(16.dp))
                        Text(
                            localization.localizedText("folders.delete.notesWarning", mapOf("folderName" to folderName)),
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.onSurfaceVariant,
                        )
                        Spacer(Modifier.height(16.dp))
                        LostNotes(noteTitles)
                        Spacer(Modifier.height(24.dp))
                        FlowRow(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End),
                        ) {
                            TextButton(
                                onClick = { step = 1 },
                                modifier = Modifier.testTag("folder-delete-back"),
                            ) { Text(localization.localizedText("common.actions.back")) }
                            Button(
                                onClick = { scope.launch { onDeleteAll() } },
                                enabled = armed,
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = colors.error,
                                    contentColor = colors.onError,
                                ),
                                modifier = Modifier.testTag("folder-delete-all"),
                            ) { Text(localization.localizedText("folders.delete.deleteAll")) }
                        }
                    }
                }
            }
        }
    }
}

/** An inset, error-tinted box naming up to three of the notes that will be deleted. */
@Composable
private fun LostNotes(titles: List<String>) {
    val localization = LocalLocalization.current
    val colors = MaterialTheme.colorScheme
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.error.copy(alpha = 0.08f))
            .padding(vertical = 4.dp),
    ) {
        titles.take(LISTED_TITLES).forEach { LostNoteRow(Icons.Filled.Description, it, muted = false) }
        if (titles.size > LISTED_TITLES) {
            LostNoteRow(
                Icons.Filled.MoreHoriz,
                localization.localizedText("folders.delete.andMore", mapOf("count" to (titles.size - LISTED_TITLES).toLong())),
                muted = true,
            )
        }
    }
}

@Composable
private fun LostNoteRow(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String, muted: Boolean) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(12.dp))
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = if (muted) colors.onSurfaceVariant else colors.onSurface,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
