package com.futo.notes.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.futo.notes.ui.components.MicroLabel
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType

/** The label + bordered card every Settings section is built from. Internal
 *  rather than private so the License row (`LicenseSettingsSection.kt`) is the
 *  same physical row as the ones below it. */
@Composable
internal fun SettingsGroup(label: String, content: @Composable () -> Unit) {
    val c = FutoTheme.colors
    MicroLabel(label, Modifier.padding(start = 4.dp, top = 12.dp, bottom = 8.dp))
    Surface(
        color = c.surface,
        shape = RoundedCornerShape(FutoRadius.md),
        border = BorderStroke(1.dp, c.border),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column { content() }
    }
}

@Composable
internal fun SettingsRow(
    title: String,
    subtitle: String? = null,
    onClick: (() -> Unit)? = null,
    titleColor: Color? = null,
    modifier: Modifier = Modifier,
    leading: @Composable (() -> Unit)? = null,
    trailing: @Composable (() -> Unit)? = null,
) {
    val c = FutoTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .fillMaxWidth()
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        if (leading != null) {
            leading()
            Spacer(Modifier.width(12.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = FutoType.body, color = titleColor ?: c.textPrimary)
            if (subtitle != null) Text(subtitle, style = FutoType.caption, color = c.textMuted)
        }
        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            trailing()
        }
    }
}

/**
 * A setting that is on or off. The whole row is the switch, as in Android's own Settings: a
 * tap on its label flips it, and TalkBack reads the label, "switch" and the state as one.
 */
@Composable
internal fun SettingsSwitchRow(title: String, subtitle: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    SettingsRow(
        title = title,
        subtitle = subtitle,
        modifier = Modifier.toggleable(checked, role = Role.Switch, onValueChange = onCheckedChange),
    ) {
        Switch(
            checked = checked,
            onCheckedChange = null,
            colors = SwitchDefaults.colors(checkedTrackColor = FutoTheme.colors.accent),
        )
    }
}

/**
 * A settings row whose control is too wide to sit beside its label: the label
 * goes above, and the control gets the row's full width.
 *
 * [SettingsRow] lays its trailing slot out first and gives the label whatever
 * is left, which is right for a badge or a short value and wrong for anything
 * that wants most of the row. At 360dp — the commonest Android width, and what
 * the QA emulators run — that left the theme picker's label narrower than the
 * word "Theme".
 */
@Composable
internal fun SettingsStackedRow(title: String, content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Text(title, style = FutoType.body, color = FutoTheme.colors.textPrimary)
        Spacer(Modifier.height(10.dp))
        content()
    }
}

@Composable
internal fun Divider() {
    HorizontalDivider(color = FutoTheme.colors.border, modifier = Modifier.padding(horizontal = 16.dp))
}
