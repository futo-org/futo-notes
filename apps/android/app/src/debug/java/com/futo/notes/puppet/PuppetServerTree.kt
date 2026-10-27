package com.futo.notes.puppet

import android.graphics.Point
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.inspector.WindowInspector
import androidx.compose.ui.platform.ViewRootForTest
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.roundToIntRect
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import com.futo.notes.puppet.PuppetServer.Binding
import org.json.JSONObject

/** Where the editor WebView is on screen, or null: under a dialog or menu a touch cannot reach it. */
private fun webviewOnScreen(bound: Binding): IntRect? {
    val webView = bound.host.webView
    val covered = touchModalAbove(windows(bound), webView.rootView) >= 0
    val onScreen = webView.isAttachedToWindow && webView.isShown && webView.width > 0 &&
        webView.height > 0 && !covered
    return if (onScreen) webView.screenRect() else null
}

/**
 * Every Compose root on screen as its merged semantics, root windows bottom to top, so a
 * dialog, popup or menu comes after the screen under it. Nodes are clipped to the part of
 * the display a tap reaches the app in — not under the keyboard or a tappable system bar,
 * which are other processes' windows. On the main thread, like the views it reads.
 */
internal fun tree(bound: Binding): PuppetReply = tree(bound.shellView, windows(bound), bound)

/** The tree read from [anchor]'s display, with the shell's rows and controls once there is one. */
internal fun tree(anchor: View, all: List<View>, bound: Binding?): PuppetReply {
    val screen = screenSize(anchor)
    val screenRect = touchableScreen(anchor, screen)
    // A dialog's window is touch-modal: a tap outside its box dismisses it instead of
    // reaching the screen beneath, so nothing below the topmost one is on screen.
    val modal = touchModalAbove(all, null)
    val windows = all.drop(modal.coerceAtLeast(0))
    val seen = mutableListOf<PuppetContract.SeenNode>()
    for ((index, root) in windows.flatMap(::composeRoots).withIndex()) {
        val rootRect = root.view.screenRect()
        walk(root.semanticsOwner.rootSemanticsNode, rootRect.topLeft, rootRect.intersect(screenRect), index, seen)
    }
    val rows = bound?.let { PuppetVerbs.listRows(it.navigator.currentScreen) }.orEmpty()
    val controls = bound?.let(::controlLabels) ?: JSONObject()
    val tree = PuppetContract.tree(density(anchor), screen, seen, rows).put("controls", controls)
        .put("webview", PuppetContract.webview(bound?.let(::webviewOnScreen)))
    return PuppetReply(200, tree.toString())
}

/**
 * What this screen's verbs' controls read now, in the app's language, each with the verbs
 * it stands for: `/tree`'s `controls`, which futo-puppet matches rows against to print
 * `→ Verb`. The verbs are `/actions`' own: the listener's for this screen, and the
 * screen's registered ones (a dialog's alone while one is up).
 */
private fun controlLabels(bound: Binding): JSONObject {
    val localization = bound.host.localization ?: return JSONObject()
    val current = bound.navigator.currentScreen
    val native = if (PuppetVerbs.modalUp()) {
        emptyList()
    } else {
        PuppetContract.nativeNames(current, bound.navigator.canGoBack)
            .map { name -> name to PuppetContract.nativeControls[name].orEmpty() }
    }
    return PuppetContract.controlLabels(
        native + PuppetVerbs.all(current).map { it.name to it.controls },
        { key -> localization.localizedText(key) },
    )
}

internal fun windows(bound: Binding): List<View> = if (Build.VERSION.SDK_INT >= 29) {
    WindowInspector.getGlobalWindowViews()
} else {
    listOf(bound.shellView.rootView) // API 28: the activity's own window, without its dialogs
}

/**
 * The index of the topmost touch-modal window other than the activity's own (a dialog,
 * a focusable popup), or -1; with [above], only one stacked over that window counts.
 */
internal fun touchModalAbove(all: List<View>, above: View?): Int {
    val floor = above?.let(all::indexOf) ?: -1
    return all.indexOfLast { window ->
        val params = window.layoutParams as? WindowManager.LayoutParams
        all.indexOf(window) > floor && params != null && PuppetContract.touchModal(params.type, params.flags)
    }
}

/** Pre-order, each node clipped to its ancestors; an unplaced node (a list's prefetch) is not on screen. */
private fun walk(
    node: SemanticsNode,
    origin: IntOffset,
    clip: IntRect,
    window: Int,
    into: MutableList<PuppetContract.SeenNode>,
) {
    if (!node.layoutInfo.isPlaced) return
    val rect = node.boundsInRoot.roundToIntRect().translate(origin).intersect(clip)
    if (rect.width <= 0 || rect.height <= 0) return
    val seen = PuppetContract.SeenNode(node.config, rect, window)
    into.add(seen)
    for (child in node.children) walk(child, origin, rect, window, into)
    seen.end = into.size
}

private fun composeRoots(view: View): List<ViewRootForTest> = when {
    !view.isShown -> emptyList()
    view is ViewRootForTest -> listOf(view)
    view is ViewGroup -> (0 until view.childCount).flatMap { composeRoots(view.getChildAt(it)) }
    else -> emptyList()
}

/**
 * `ponytail:` the shell window's insets, read as display coordinates because the window
 * is the whole display edge to edge; a split-screen window would need its own origin.
 */
private fun touchableScreen(view: View, screen: IntSize): IntRect {
    val covered = ViewCompat.getRootWindowInsets(view)
        ?.getInsets(WindowInsetsCompat.Type.ime() or WindowInsetsCompat.Type.tappableElement())
        ?: return IntRect(0, 0, screen.width, screen.height)
    return IntRect(covered.left, covered.top, screen.width - covered.right, screen.height - covered.bottom)
}

private fun density(view: View) = view.resources.displayMetrics.density

/** The whole display in its current rotation, system bars included: what `adb shell input` addresses. */
@Suppress("DEPRECATION")
private fun screenSize(view: View): IntSize {
    val size = Point()
    (view.display ?: view.context.getSystemService(WindowManager::class.java).defaultDisplay).getRealSize(size)
    return IntSize(size.x, size.y)
}

private fun View.screenRect(): IntRect {
    val location = IntArray(2).also(::getLocationOnScreen)
    return IntRect(location[0], location[1], location[0] + width, location[1] + height)
}
