package com.futo.notes.puppet

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf
import com.futo.notes.ui.navigation.Screen

/**
 * The screens' own controls, for the debug listener (PuppetServer.kt). The
 * shell's navigation verbs live in the listener because they are the navigator's; the
 * editor's text verbs live in the WebView. Everything in between — the title field,
 * the find bar, the ⋯ menu, a list's New note and row menus, the folder dialogs and
 * sheets, the danger zone, the Feedback composer, the crash dialog — is Compose state
 * inside one screen, reachable from nowhere else. Same contract as iOS's `PuppetVerbs`
 * and `registerPuppetVerbs` on desktop.
 */
internal object PuppetVerbs {
    private class Scope(
        val screen: Screen?,
        val modal: Boolean,
        val listRows: (() -> List<String>)?,
        val verbs: () -> List<PuppetVerb>,
    )

    /** By token, in registration order, so the screen composed last wins a shared name. */
    private val scopes = LinkedHashMap<Any, Scope>()

    /**
     * The note the open editor is showing RIGHT NOW. The stack entry keeps the id the
     * push carried, so after a rename in place it names a note that no longer exists;
     * this is what the editor itself holds. Null when no editor is up.
     */
    @Volatile
    var openNote: String? = null

    /** Whether that editor has read [openNote] from disk and handed it to the WebView. */
    @Volatile
    var openNoteLoaded = false

    /**
     * What the app last put on the clipboard and how many copies it has made: `state`'s
     * `copied`, so a receipt says what was copied without reading the clipboard, which holds
     * whatever the user copied anywhere else.
     */
    @Volatile
    var copied: Pair<Int, String>? = null
        private set

    fun recordCopy(text: String) {
        copied = (copied?.first ?: 0) + 1 to text
    }

    /**
     * What the app last handed the OS to open — a page, mail, system Settings — and how
     * many: `state`'s `opened`, so a receipt names it.
     */
    @Volatile
    var opened: Pair<Int, String>? = null
        private set

    fun recordOpen(url: String) {
        opened = (opened?.first ?: 0) + 1 to url
    }

    /**
     * What a user could do on [current] right now. AnimatedContent keeps the screen
     * being left composed through the transition, so a scope counts only while its
     * own entry is the one on top; a scope outside the stack (a dialog over the
     * whole shell) counts everywhere. Each scope is asked afresh, so a screen answers
     * with its live state — the find bar's verbs only while the bar is up.
     */
    fun all(current: Screen?): List<PuppetVerb> =
        modalVerbs().ifEmpty {
            scopes.values.filter { it.screen == null || it.screen === current }.flatMap { it.verbs() }
        }

    /**
     * A modal dialog is up, so nothing beneath it — the shell's verbs included — is on screen.
     * It counts while it has verbs, the same rule as iOS's crash sheet.
     */
    fun modalUp(): Boolean = modalVerbs().isNotEmpty()

    private fun modalVerbs(): List<PuppetVerb> = scopes.values.filter { it.modal }.flatMap { it.verbs() }

    fun verb(named: String, current: Screen?): PuppetVerb? = all(current).lastOrNull { it.name == named }

    /** The row tags of the list [current] shows (PuppetListRows.kt), or null when it shows none. */
    fun listRows(current: Screen?): List<String>? =
        scopes.values.lastOrNull { it.screen === current && it.listRows != null }?.listRows?.invoke()

    fun register(
        token: Any,
        screen: Screen?,
        modal: Boolean,
        listRows: (() -> List<String>)?,
        verbs: () -> List<PuppetVerb>,
    ) {
        scopes.remove(token)
        scopes[token] = Scope(screen, modal, listRows, verbs)
    }

    fun unregister(token: Any) {
        scopes.remove(token)
    }
}

/** The stack entry this part of the tree renders, so its verbs retire with it. */
private val LocalPuppetScreen = staticCompositionLocalOf<Screen?> { null }

@Composable
internal fun PuppetScreen(screen: Screen, content: @Composable () -> Unit) =
    CompositionLocalProvider(LocalPuppetScreen provides screen, content = content)

/**
 * The verbs this screen's controls are, for as long as it is composed. A [modal] scope is a
 * dialog over everything: while it is up, its verbs are the only ones on offer. [listRows] are
 * the rows of the list the screen shows, when it shows one (PuppetListRows.kt).
 */
@Composable
internal fun PuppetVerbScope(
    modal: Boolean = false,
    listRows: (() -> List<String>)? = null,
    verbs: () -> List<PuppetVerb>,
) {
    val latest by rememberUpdatedState(verbs)
    val latestRows by rememberUpdatedState(listRows)
    val listsRows = listRows != null
    val screen = LocalPuppetScreen.current
    val token = remember { Any() }
    DisposableEffect(token, screen, modal, listsRows) {
        // A screen with verbs is drivable even before the shell is up — the first-run
        // storage picker is — so registering opens the listener if nothing has yet.
        PuppetServer.open()
        val rows = if (listsRows) ({ latestRows?.invoke().orEmpty() }) else null
        PuppetVerbs.register(token, screen, modal, rows) { latest() }
        onDispose { PuppetVerbs.unregister(token) }
    }
}

/**
 * Publish the id the open editor is showing, for the listener's `screen`, and whether it has
 * [loaded]: a write into the document before the load lands is overwritten by it.
 */
@Composable
internal fun PuppetOpenNote(noteId: String, loaded: Boolean) {
    DisposableEffect(noteId, loaded) {
        PuppetVerbs.openNote = noteId
        PuppetVerbs.openNoteLoaded = loaded
        // Only our own: the screen being left disposes AFTER the next one has composed
        // (AnimatedContent keeps both through the transition).
        onDispose {
            if (PuppetVerbs.openNote == noteId) {
                PuppetVerbs.openNote = null
                PuppetVerbs.openNoteLoaded = false
            }
        }
    }
}

/** The app put [text] on the clipboard (see [PuppetVerbs.copied]). */
internal fun recordPuppetCopy(text: String) = PuppetVerbs.recordCopy(text)

/** The app handed [url] to the OS to open (see [PuppetVerbs.opened]). */
internal fun recordPuppetOpen(url: String) = PuppetVerbs.recordOpen(url)
