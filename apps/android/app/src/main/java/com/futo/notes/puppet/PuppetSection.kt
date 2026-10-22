package com.futo.notes.puppet

import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics

/**
 * The part of the screen a container is, for the agent's `/tree` `section`, where the tree's
 * shape cannot say it: the app bar, the New-note button and the editor's find bar on a screen
 * with no list to sit above or below (the editor, Sync, an empty folder), and the editor's
 * toolbar riding the keyboard. Everything else is placed from structure
 * (`PuppetContract.sections` in the debug listener). Accessibility services never see this key.
 */
internal val PuppetSection = SemanticsPropertyKey<String>("PuppetSection")

/** Mark this container as [section]: `top bar`, `bottom bar` or `keyboard toolbar`. */
internal fun Modifier.puppetSection(section: String): Modifier = semantics { this[PuppetSection] = section }

/**
 * Mark a row's menu with the row it is open for ([rowTag], `note:<id>` or `folder:<path>`), so
 * its section reads `menu · note "<id>"`: the row its items act on.
 */
internal fun Modifier.puppetMenuFor(rowTag: String): Modifier =
    puppetSection("${rowTag.substringBefore(':')} \"${rowTag.substringAfter(':')}\"")

/** What a classic Android text field hosted in Compose shows, read when `/tree` asks. */
internal class PuppetHostedField(val text: String, val description: String?, val focused: Boolean)

/**
 * A text field that is a classic Android view inside an `AndroidView` (the find bar's query),
 * which the semantics tree cannot see into, so `/tree` would have no row for it. The reader
 * calls [read] on the main thread. Like [PuppetSection], not an accessibility property:
 * TalkBack reads the view itself, as before.
 */
internal val PuppetHostedFieldKey = SemanticsPropertyKey<() -> PuppetHostedField?>("PuppetHostedField")

internal fun Modifier.puppetHostedField(read: () -> PuppetHostedField?): Modifier =
    semantics { this[PuppetHostedFieldKey] = read }
