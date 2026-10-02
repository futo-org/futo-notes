package com.futo.notes.ui.settings.appicon

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.components.TopBar
import com.futo.notes.ui.theme.FutoTheme

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppIconSheet(controller: AppIconController, onSelect: (AppIcon) -> Unit, onDismiss: () -> Unit) {
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.surface,
    ) {
        TopBar(
            title = { Text(localization.localizedText("settings.appIcon.heading"), color = colors.textPrimary) },
            navigationIcon = {
                IconButton(onClick = onDismiss) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = localization.localizedText("common.actions.back"), tint = colors.textPrimary)
                }
            },
        )
        if (controller.changing) {
            Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(24.dp), color = colors.accent)
                Spacer(Modifier.width(12.dp))
                Text(localization.localizedText("settings.appIcon.changing"), color = colors.textPrimary)
            }
        }
        if (controller.failed) {
            Text(localization.localizedText("settings.appIcon.failed"),
                color = colors.danger, modifier = Modifier.padding(16.dp))
        }
        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
            contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(AppIcon.entries, key = { it.id }) { icon ->
                val isSelected = controller.selected == icon
                val label = localization.localizedText(icon.labelKey)
                OutlinedCard(
                    onClick = { onSelect(icon) },
                    enabled = !controller.changing,
                    modifier = Modifier.semantics { selected = isSelected },
                    colors = CardDefaults.outlinedCardColors(containerColor = colors.surface),
                ) {
                    Column(Modifier.fillMaxWidth().padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Image(painterResource(icon.preview), contentDescription = null, modifier = Modifier.size(80.dp).clip(RoundedCornerShape(16.dp)))
                        Spacer(Modifier.height(8.dp))
                        Text(label, color = colors.textPrimary)
                        Box(Modifier.height(28.dp), contentAlignment = Alignment.Center) {
                            if (isSelected) Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = colors.accent)
                        }
                    }
                }
            }
        }
    }
}
