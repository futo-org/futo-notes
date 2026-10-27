package com.futo.notes.ui.settings.appicon

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.futo.notes.puppet.PuppetVerb
import com.futo.notes.puppet.PuppetVerbRefusal
import com.futo.notes.puppet.PuppetVerbScope
import androidx.compose.ui.unit.em
import com.futo.notes.R
import com.futo.notes.license.catalogPath
import com.futo.notes.localization.LocalLocalization
import com.futo.notes.ui.components.ConfirmDialog
import com.futo.notes.ui.components.TopBar
import com.futo.notes.ui.theme.FutoRadius
import com.futo.notes.ui.theme.FutoTheme
import com.futo.notes.ui.theme.FutoType
import uniffi.futo_notes_ffi.LicenseAction
import uniffi.futo_notes_ffi.LicenseInclusion
import uniffi.futo_notes_ffi.LicensePurchaseSurface

/**
 * The App icon picker. Choosing an icon beyond Standard and Reversed is included with a license
 * (docs/spec/license.md § What a license includes): what the grid shows per
 * license state is [appIconPickerShape], from Rust's `includes` (`null` while
 * the license is still being read) and row actions.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppIconSheet(
    controller: AppIconController,
    includes: Set<LicenseInclusion>?,
    rowActions: List<LicenseAction>,
    surface: LicensePurchaseSurface,
    /** The storefront address `play` names as plain text (Rust's `LicenseLinks.website`). */
    website: String,
    onSelect: (AppIcon) -> Unit,
    onBuy: () -> Unit,
    onAlreadyPaid: () -> Unit,
    /** The one-time header after an activation. Lives only for this presentation. */
    showsLanding: Boolean = false,
    onDismiss: () -> Unit,
) {
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
    val everyInstallHas = remember { AppIcon.everyInstallHas() }
    val shape = appIconPickerShape(controller.selected, includes, rowActions, surface, everyInstallHas)
    // Disabling the launcher alias that rooted the task makes Android finish
    // that task, so a change is confirmed first (Signal's convention). Full
    // reset calls controller.reset() directly and never passes through here.
    var pending by rememberSaveable { mutableStateOf<AppIcon?>(null) }
    // The icon whose ask is up.
    var asking by rememberSaveable { mutableStateOf<AppIcon?>(null) }
    // A license arriving while the ask is up (bought from it, or a key typed
    // after "I already paid") drops the ask; nothing else about the shape may.
    val included = includes?.contains(LicenseInclusion.APP_ICON) == true
    LaunchedEffect(included) { if (included) asking = null }

    /** A tap on [icon]'s tile: the ask, the confirm before an OS change, or nothing (false) for the current icon. */
    fun pick(icon: AppIcon): Boolean {
        when {
            shape.asks(icon) -> asking = icon
            icon != controller.selected -> pending = icon
            else -> return false
        }
        return true
    }
    // The picker's verbs while nothing is up over it: the ask and the confirmation have their own.
    PuppetVerbScope(modal = true) {
        if (asking != null || pending != null) return@PuppetVerbScope emptyList()
        listOf(
            // A tap on a tile: the ask for an icon a license includes, otherwise the
            // confirmation, which its ConfirmDialog or DismissDialog answers.
            PuppetVerb("SelectAppIcon", required = listOf("icon"), optional = listOf("answer")) { arguments ->
                val id = arguments.optString("icon")
                val icon = AppIcon.entries.firstOrNull { it.id == id }
                    ?: throw PuppetVerbRefusal(400, "no icon $id: one of ${AppIcon.entries.joinToString { it.id }}")
                if (controller.changing) throw PuppetVerbRefusal(409, "the icons are disabled while one is changing")
                if (!shape.resolved) throw PuppetVerbRefusal(503, "the icons are disabled until the license is read")
                if (!pick(icon)) throw PuppetVerbRefusal(409, "$id is already the icon")
            },
            PuppetVerb("CloseAppIcons", controls = listOf("common.actions.back")) {
                onDismiss()
            },
        )
    }
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
        if (showsLanding) LandingHeader()
        ChangeStatus(controller)
        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            modifier = Modifier.fillMaxWidth().weight(1f, fill = false),
            contentPadding = PaddingValues(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(AppIcon.entries, key = { it.id }) { icon ->
                AppIconTile(
                    icon,
                    selected = controller.selected == icon,
                    coined = icon in shape.coined,
                    enabled = !controller.changing && shape.resolved,
                ) { pick(icon) }
            }
            if (shape.footnote) {
                item(span = { GridItemSpan(maxLineSpan) }) { Footnote(shape.footnoteKey) }
            }
        }
    }
    pending?.let { icon ->
        ConfirmIconChange(icon, onConfirm = { pending = null; onSelect(icon) }, onDismiss = { pending = null })
    }
    val ask = shape.ask
    val askedIcon = asking
    if (askedIcon != null && ask != null) {
        AppIconAskSheet(
            icon = askedIcon,
            ask = ask,
            website = website,
            onBuy = onBuy,
            onAlreadyPaid = { asking = null; onAlreadyPaid() },
            onNotNow = { asking = null },
        )
    }
}

/** While an OS change is pending, and after one failed. */
@Composable
private fun ChangeStatus(controller: AppIconController) {
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
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
}

/** One choice in the grid: artwork (coined or not), name, and the selection check. */
@Composable
private fun AppIconTile(icon: AppIcon, selected: Boolean, coined: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
    val label = localization.localizedText(icon.labelKey)
    val a11yLabel = if (coined) {
        localization.localizedText("settings.appIcon.license.a11yIncluded", mapOf("iconName" to label))
    } else {
        label
    }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .clickable(enabled = enabled, onClick = onClick)
            .semantics {
                this.selected = selected
                contentDescription = a11yLabel
            }
            .testTag("app-icon-" + icon.id)
            .padding(12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        IconArtwork(icon, size = 80.dp, coinDiameter = 26.dp, coined = coined)
        Spacer(Modifier.height(8.dp))
        Text(label, color = colors.textPrimary)
        Box(Modifier.height(28.dp), contentAlignment = Alignment.Center) {
            if (selected) Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = colors.accent)
        }
    }
}

/**
 * Disabling the launcher alias that rooted the task makes Android finish that
 * task, so a change is confirmed first (Signal's convention).
 */
@Composable
private fun ConfirmIconChange(icon: AppIcon, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    val localization = LocalLocalization.current
    ConfirmDialog(
        title = localization.localizedText("settings.appIcon.confirm.title",
            mapOf("iconName" to localization.localizedText(icon.labelKey))),
        body = localization.localizedText("settings.appIcon.confirm.body"),
        confirmLabelKey = "settings.appIcon.confirm.action",
        destructive = false,
        onConfirm = { onConfirm() },
        onDismiss = onDismiss,
    )
}

/**
 * The artwork with the supporter coin overhanging its bottom-end corner (the
 * coin's center sits on the rounded corner, like a notification badge), so it
 * never reads as part of the icon.
 */
@Composable
private fun IconArtwork(icon: AppIcon, size: Dp, coinDiameter: Dp, coined: Boolean) {
    Box(Modifier.size(size)) {
        Image(painterResource(icon.preview), contentDescription = null,
            modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(size / 5)))
        if (coined) {
            CoinBadge(
                coinDiameter,
                Modifier.align(Alignment.BottomEnd).offset(x = coinDiameter * 0.3f, y = coinDiameter * 0.3f),
            )
        }
    }
}

/**
 * The supporter coin's flat artwork, small, with a ring in the surface color so
 * it reads against any icon. Flat on purpose: the turning coin at badge size
 * reads as a dark disc, and six live renderers in a grid are not free.
 * Decorative: the tile's label carries the meaning.
 */
@Composable
internal fun CoinBadge(diameter: Dp, modifier: Modifier = Modifier, ring: Boolean = true) {
    Image(
        painterResource(R.drawable.ic_supporter_coin),
        contentDescription = null,
        modifier = modifier
            .size(diameter + if (ring) 4.dp else 0.dp)
            .then(if (ring) Modifier.background(FutoTheme.colors.surface, CircleShape).padding(2.dp) else Modifier),
    )
}

@Composable
private fun Footnote(path: String) {
    val localization = LocalLocalization.current
    val sentence = localization.localizedText(path)
    // The coin is part of the text run, so it follows the last word instead of
    // floating at the far edge; a no-break space keeps it from being orphaned.
    val text = buildAnnotatedString {
        append(sentence)
        append(' ')
        appendInlineContent("coin")
    }
    val coin = InlineTextContent(Placeholder(1.1.em, 1.1.em, PlaceholderVerticalAlign.TextCenter)) {
        Image(painterResource(R.drawable.ic_supporter_coin), contentDescription = null, modifier = Modifier.fillMaxSize())
    }
    Text(
        text,
        inlineContent = mapOf("coin" to coin),
        style = FutoType.caption,
        color = FutoTheme.colors.textMuted,
        textAlign = TextAlign.Center,
        // Read as the sentence alone: the coin's placeholder character is not
        // something to announce.
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp)
            .semantics { contentDescription = sentence }
            .testTag("app-icon-footnote"),
    )
}

@Composable
private fun LandingHeader() {
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .padding(horizontal = 16.dp)
            .fillMaxWidth()
            .background(colors.accent.copy(alpha = 0.10f), RoundedCornerShape(14.dp))
            .padding(14.dp)
            .semantics(mergeDescendants = true) {}
            .testTag("app-icon-landing"),
    ) {
        CoinBadge(36.dp, ring = false)
        Spacer(Modifier.width(12.dp))
        Column {
            Text(localization.localizedText("license.explanationLicensed"),
                style = FutoType.body, fontWeight = FontWeight.Bold, color = colors.textPrimary)
            Text(localization.localizedText("settings.appIcon.license.landing"),
                style = FutoType.caption, color = colors.textMuted)
        }
    }
}

/**
 * The ask over the picker: what a license includes, and the one way forward the
 * build allows. Link-out or key-only is decided by the caller from Rust's row
 * actions.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AppIconAskSheet(
    icon: AppIcon,
    ask: AppIconPickerShape.Ask,
    website: String,
    onBuy: () -> Unit,
    onAlreadyPaid: () -> Unit,
    onNotNow: () -> Unit,
) {
    val localization = LocalLocalization.current
    val colors = FutoTheme.colors
    PuppetVerbScope(modal = true) {
        buildList {
            if (ask is AppIconPickerShape.Ask.LinkOut) {
                add(PuppetVerb("BuyLicense") { onBuy() })
            }
            add(PuppetVerb("StartLicenseEntry") { onAlreadyPaid() })
            add(PuppetVerb("DismissDialog") { onNotNow() })
        }
    }
    ModalBottomSheet(
        onDismissRequest = onNotNow,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.surface,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 16.dp),
        ) {
            Spacer(Modifier.height(8.dp))
            IconArtwork(icon, size = 88.dp, coinDiameter = 34.dp, coined = true)
            Spacer(Modifier.height(18.dp))
            Text(
                localization.localizedText("settings.appIcon.license.sheetTitle"),
                style = FutoType.title,
                color = colors.textPrimary,
                modifier = Modifier.semantics { heading() }.testTag("app-icon-ask-title"),
            )
            Spacer(Modifier.height(8.dp))
            // Plain text throughout: the named website is never a link.
            Text(
                when (ask) {
                    is AppIconPickerShape.Ask.LinkOut -> localization.localizedText("settings.appIcon.license.sheetBody")
                    AppIconPickerShape.Ask.NameWebsite -> localization.localizedText(
                        "settings.appIcon.license.sheetBodyWebsite", mapOf("url" to website),
                    )
                    AppIconPickerShape.Ask.KeyOnly -> localization.localizedText("license.keyOnlyExplanation")
                },
                style = FutoType.body,
                color = colors.textMuted,
                textAlign = TextAlign.Center,
                modifier = Modifier.testTag("app-icon-ask-body"),
            )
            Spacer(Modifier.height(18.dp))
            when (ask) {
                is AppIconPickerShape.Ask.LinkOut -> {
                    Filled(localization.localizedText(ask.primary.catalogPath()), "app-icon-ask-buy", onBuy)
                    Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        Link(localization.localizedText(LicenseAction.ENTER_KEY.catalogPath()), "app-icon-ask-already-paid", onAlreadyPaid)
                        Link(localization.localizedText("settings.appIcon.license.notNow"), "app-icon-ask-not-now", onNotNow)
                    }
                }
                AppIconPickerShape.Ask.NameWebsite, AppIconPickerShape.Ask.KeyOnly -> {
                    Filled(localization.localizedText(LicenseAction.ENTER_KEY.catalogPath()), "app-icon-ask-already-paid", onAlreadyPaid)
                    Link(localization.localizedText("settings.appIcon.license.notNow"), "app-icon-ask-not-now", onNotNow)
                }
            }
        }
    }
}

@Composable
private fun Filled(label: String, tag: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        shape = RoundedCornerShape(FutoRadius.sm),
        modifier = Modifier.fillMaxWidth().testTag(tag),
    ) { Text(label) }
}

@Composable
private fun Link(label: String, tag: String, onClick: () -> Unit) {
    TextButton(onClick = onClick, modifier = Modifier.testTag(tag)) {
        Text(label, color = FutoTheme.colors.textAccent)
    }
}
