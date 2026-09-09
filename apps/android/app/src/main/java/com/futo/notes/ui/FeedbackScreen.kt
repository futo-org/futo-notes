package com.futo.notes.ui

import android.content.Context
import android.graphics.BitmapFactory
import android.widget.Toast
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.futo.notes.BuildConfig
import com.futo.notes.CrashlogEndpoint
import com.futo.notes.FeedbackImages
import com.futo.notes.FeedbackSubmission
import com.futo.notes.ImagePicker
import com.futo.notes.Prefs
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.components.TopBar
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import kotlinx.coroutines.launch
@Composable
fun FeedbackScreen(picker: ImagePicker, onBack: () -> Unit, onSent: () -> Unit) {
    val c = FutoTheme.colors
    val context = LocalContext.current
    val localization = LocalLocalization.current
    val scope = rememberCoroutineScope()
    val prefs = remember { context.getSharedPreferences(Prefs.FILE, Context.MODE_PRIVATE) }

    var message by remember { mutableStateOf(prefs.getString(Prefs.FEEDBACK_DRAFT, "") ?: "") }
    var images by remember { mutableStateOf(listOf<ByteArray>()) }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf("") }
    var staging by remember { mutableStateOf(prefs.getBoolean(Prefs.CRASHLOG_STAGING, false)) }

    fun addScreenshots() {
        error = ""
        picker.pickLibrary(FeedbackImages.MAX_ATTACHMENTS - images.size) { uris ->
            scope.launch {
                val added = uris.mapNotNull { FeedbackImages.normalize(context.contentResolver, it) }
                if (added.size < uris.size) error = localization.localizedText("feedback.screenshotsTooLarge")
                images = images + added
            }
        }
    }

    fun send() {
        scope.launch {
            sending = true
            error = ""
            val sent = FeedbackSubmission.send(message.trim(), images)
            if (sent) {
                prefs.edit().remove(Prefs.FEEDBACK_DRAFT).apply()
                message = ""
                images = emptyList()
                Toast.makeText(context, localization.localizedText("feedback.sentThanks"), Toast.LENGTH_SHORT).show()
                onSent()
            } else {
                error = localization.localizedText("feedback.sendFailedRetry")
            }
            sending = false
        }
    }

    Scaffold(containerColor = c.surface, topBar = { FeedbackTopBar(onBack) }) { padding ->
        Column(
            modifier = Modifier
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            MessageField(
                value = message,
                canAttach = images.size < FeedbackImages.MAX_ATTACHMENTS,
                onAddScreenshot = ::addScreenshots,
            ) {
                message = it.take(FeedbackSubmission.MAX_MESSAGE_LENGTH)
                prefs.edit().putString(Prefs.FEEDBACK_DRAFT, message).apply()
            }

            if (images.isNotEmpty()) {
                AttachmentStrip(images) { index ->
                    images = images.filterIndexed { position, _ -> position != index }
                }
            }

            if (error.isNotEmpty()) {
                Text(error, style = FutoType.caption, color = c.danger)
            }

            Button(
                onClick = ::send,
                enabled = message.isNotBlank() && !sending,
                colors = ButtonDefaults.buttonColors(
                    containerColor = c.accent,
                    contentColor = c.textOnInk,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    localization.localizedText(if (sending) "feedback.sending" else "common.actions.send"),
                    style = FutoType.small,
                )
            }

            if (BuildConfig.DEBUG) {
                StagingRow(staging) {
                    staging = it
                    prefs.edit().putBoolean(Prefs.CRASHLOG_STAGING, it).apply()
                }
            }
        }
    }
}

@Composable
private fun FeedbackTopBar(onBack: () -> Unit) {
    val c = FutoTheme.colors
    val localization = LocalLocalization.current
    TopBar(
        title = {
            Text(
                localization.localizedText("settings.issueReporting.sendFeedback"),
                style = FutoType.title,
                color = c.textPrimary,
            )
        },
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = localization.localizedText("common.actions.back"),
                    tint = c.textSecondary,
                )
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MessageField(
    value: String,
    canAttach: Boolean,
    onAddScreenshot: () -> Unit,
    onValueChange: (String) -> Unit,
) {
    val c = FutoTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val colors = OutlinedTextFieldDefaults.colors(
        focusedContainerColor = c.surfaceSunken,
        unfocusedContainerColor = c.surfaceSunken,
        focusedBorderColor = c.accent,
        unfocusedBorderColor = c.border,
        focusedPlaceholderColor = c.textMuted,
        unfocusedPlaceholderColor = c.textMuted,
    )
    Box {
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            textStyle = FutoType.body.copy(color = c.textPrimary),
            cursorBrush = SolidColor(c.accent),
            interactionSource = interaction,
            modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp),
        ) { innerTextField ->
            OutlinedTextFieldDefaults.DecorationBox(
                value = value,
                innerTextField = innerTextField,
                enabled = true,
                singleLine = false,
                visualTransformation = VisualTransformation.None,
                interactionSource = interaction,
                placeholder = {
                    Text(LocalLocalization.current.localizedText("feedback.placeholder"), style = FutoType.body)
                },
                colors = colors,
                contentPadding = PaddingValues(start = 16.dp, top = 16.dp, end = 16.dp, bottom = 48.dp),
                container = {
                    OutlinedTextFieldDefaults.Container(
                        enabled = true,
                        isError = false,
                        interactionSource = interaction,
                        colors = colors,
                        shape = RoundedCornerShape(FutoRadius.md),
                    )
                },
            )
        }
        IconButton(
            onClick = onAddScreenshot,
            enabled = canAttach,
            modifier = Modifier.align(Alignment.BottomEnd).padding(end = 4.dp, bottom = 4.dp),
        ) {
            Icon(
                Icons.Outlined.Image,
                contentDescription = LocalLocalization.current.localizedText("feedback.addScreenshot"),
                tint = c.textMuted,
            )
        }
    }
}

@Composable
private fun AttachmentStrip(images: List<ByteArray>, onRemove: (Int) -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.horizontalScroll(rememberScrollState()),
    ) {
        images.forEachIndexed { index, bytes ->
            AttachmentThumbnail(bytes, index) { onRemove(index) }
        }
    }
}

@Composable
private fun StagingRow(staging: Boolean, onChange: (Boolean) -> Unit) {
    val c = FutoTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
        Column(Modifier.weight(1f)) {
            Text(
                LocalLocalization.current.localizedText("feedback.stagingServer"),
                style = FutoType.small,
                color = c.textPrimary,
            )
            Text(
                CrashlogEndpoint.devBaseUrl(staging),
                style = FutoType.caption,
                color = c.textMuted,
            )
        }
        Switch(
            checked = staging,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(checkedTrackColor = c.accent),
        )
    }
}

@Composable
private fun AttachmentThumbnail(bytes: ByteArray, index: Int, onRemove: () -> Unit) {
    val localization = LocalLocalization.current
    val bitmap = remember(bytes) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }
    Box(Modifier.size(72.dp)) {
        if (bitmap != null) {
            Image(
                bitmap = bitmap.asImageBitmap(),
                contentDescription = localization.localizedText("feedback.attachedScreenshot", mapOf("index" to index + 1)),
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(72.dp).clip(RoundedCornerShape(10.dp)),
            )
        }
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .padding(2.dp)
                .size(20.dp)
                .background(Color.Black.copy(alpha = 0.6f), CircleShape)
                .clickable(onClick = onRemove),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                Icons.Filled.Close,
                contentDescription = localization.localizedText("feedback.removeScreenshot", mapOf("index" to index + 1)),
                tint = Color.White,
                modifier = Modifier.size(14.dp),
            )
        }
    }
}
