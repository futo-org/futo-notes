package com.futo.notes.puppet

import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.ScrollAxisRange
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import com.futo.notes.puppet.PuppetContract.SeenNode
import org.json.JSONArray
import org.json.JSONObject

private fun PuppetContract.size(width: Int, height: Int) = JSONObject().put("w", width).put("h", height)

/** `/tree`'s `webview`: where the editor WebView sits in device pixels, null when it is not on screen. */
internal fun PuppetContract.webview(rect: IntRect?): Any =
    rect?.let { JSONObject().put("x", it.left).put("y", it.top).put("w", it.width).put("h", it.height) }
        ?: JSONObject.NULL

/**
 * `GET /tree`: the nodes a person can read or touch, in walk order, each with its
 * [sections] entry, and the [scrolls] of the containers they are in. A node something takes
 * touches from is cut down to what a later Surface or clickable leaves of it, so a row
 * scrolled under the top bar is not offered for a tap the bar would take. `ponytail:` a
 * cover only trims a side it spans whole — a corner (the FAB over a row) leaves the rect as
 * it was, the way a bounding box of the uncovered region would. [rows] are the tags of the
 * rows the screen's list holds, in order (PuppetListRows.kt).
 */
internal fun PuppetContract.tree(scale: Float, screen: IntSize, seen: List<SeenNode>, rows: List<String> = emptyList()): JSONObject {
    val reach = seen.map { node ->
        var rect: IntRect? = node.rect
        if (actions(node.config).isNotEmpty()) {
            for (later in seen.subList(node.end, seen.size)) {
                if (takesTouches(later.config)) rect = rect?.uncoveredBy(later.rect)
            }
        }
        rect
    }
    val sections = sections(seen, reach)
    val nodes = JSONArray()
    val listed = mutableListOf<Int>()
    for ((index, node) in seen.withIndex()) {
        val json = reach[index]?.let { treeNode(node.config, it) } ?: continue
        nodes.put(json.put("section", sections[index]))
        listed += index
    }
    return JSONObject()
        .put("screen", size(screen.width, screen.height))
        .put("scale", scale.toDouble())
        .put("nodes", nodes)
        .put("scroll", scrolls(seen, sections, listed, rows))
}

private fun PuppetContract.isScroller(config: SemanticsConfiguration) =
    SemanticsProperties.VerticalScrollAxisRange in config || SemanticsProperties.HorizontalScrollAxisRange in config

/**
 * Each node's `section`, the part of the screen it is in, in the words iOS answers with.
 * A region — `keyboard toolbar`, `top bar` or `bottom bar` for a container that says it is
 * one ([PuppetSection]); `list` inside the window's main list (its largest vertical
 * scroller), `scroll` inside any other; `top bar` wholly above the main list, `bottom bar`
 * below its middle (under it, or the FAB floating over its lower half); else `content` —
 * prefixed by the surface the window is: `dialog`, `sheet` (a dialog or popup something can
 * dismiss, as a bottom sheet's handle does), or `menu`, which is the whole section, followed
 * by the row it is open for when it says one ([puppetMenuFor]).
 * [reach] is each node's rect after what is drawn over it, so the list's top is where the
 * bar over it ends.
 */
private fun PuppetContract.sections(seen: List<SeenNode>, reach: List<IntRect?>): List<String> {
    fun inside(outer: Int, inner: Int) = inner in outer until seen[outer].end
    val marked = seen.indices.filter { PuppetSection in seen[it].config }
    val scrollers = seen.indices.filter { isScroller(seen[it].config) }
    val windows = seen.indices.groupBy { seen[it].window }
    val surfaces = windows.mapValues { (_, members) -> surface(members.map { seen[it].config }) }
    val mainLists = windows.mapValues { (_, members) ->
        members.filter { it in scrollers && SemanticsProperties.VerticalScrollAxisRange in seen[it].config }
            .maxByOrNull { seen[it].rect.width.toLong() * seen[it].rect.height }
    }
    fun region(index: Int): String {
        marked.lastOrNull { inside(it, index) }?.let { return seen[it].config[PuppetSection] }
        val mainList = mainLists[seen[index].window]
        scrollers.lastOrNull { inside(it, index) }?.let { return if (it == mainList) "list" else "scroll" }
        val list = mainList?.let { reach[it] ?: seen[it].rect } ?: return "content"
        val rect = reach[index] ?: seen[index].rect
        return when {
            rect.bottom <= list.top -> "top bar"
            rect.top >= list.center.y -> "bottom bar"
            else -> "content"
        }
    }
    return seen.indices.map { index ->
        val surface = surfaces.getValue(seen[index].window)
        val region = if (surface == "menu") {
            marked.lastOrNull { inside(it, index) }?.let { seen[it].config[PuppetSection] } ?: "content"
        } else {
            region(index)
        }
        when {
            surface == null -> region
            region == "content" -> surface
            else -> "$surface · $region"
        }
    }
}

/** The surface a window's nodes are: null for the screen itself. */
private fun PuppetContract.surface(configs: List<SemanticsConfiguration>): String? = when {
    configs.none { SemanticsProperties.IsDialog in it || SemanticsProperties.IsPopup in it } -> null
    configs.any { SemanticsActions.Dismiss in it } -> "sheet"
    configs.any { SemanticsProperties.IsDialog in it } -> "dialog"
    else -> "menu"
}

/**
 * `/tree`'s `scroll`: one `{section, up, down, left, right}` per scrolling container holding
 * a [listed] node, saying which ways more content lies, plus `first`, `last` (1-based) and
 * `total` when some of those nodes are [rows]: the positions of the first and last row on
 * screen, and how many rows the list has. A menu's are left out, as iOS leaves them.
 */
private fun PuppetContract.scrolls(
    seen: List<SeenNode>,
    sections: List<String>,
    listed: List<Int>,
    rows: List<String>,
): JSONArray {
    val entries = JSONArray()
    for ((container, node) in seen.withIndex()) {
        if (!isScroller(node.config) || sections[container] == "menu") continue
        val held = listed.filter { it in container until node.end }
        if (held.isEmpty()) continue
        val (up, down) = ways(node.config.getOrNull(SemanticsProperties.VerticalScrollAxisRange))
        val (left, right) = ways(node.config.getOrNull(SemanticsProperties.HorizontalScrollAxisRange))
        val entry = JSONObject().put("section", sections[container])
            .put("up", up).put("down", down).put("left", left).put("right", right)
        val positions = held.mapNotNull { index ->
            seen[index].config.getOrNull(SemanticsProperties.TestTag)?.let(rows::indexOf)?.takeIf { it >= 0 }
        }
        if (positions.isNotEmpty()) {
            entry.put("first", positions.min() + 1).put("last", positions.max() + 1).put("total", rows.size)
        }
        entries.put(entry)
    }
    return entries
}

/** Whether there is more content before and after the scroll position on this axis. */
private fun PuppetContract.ways(range: ScrollAxisRange?): Pair<Boolean, Boolean> {
    if (range == null) return false to false
    val before = range.value() > 0f
    val after = range.value() < range.maxValue()
    return if (range.reverseScrolling) after to before else before to after
}

/** A Material Surface (a traversal group that swallows touches) or anything clickable. */
private fun PuppetContract.takesTouches(config: SemanticsConfiguration) =
    config.getOrNull(SemanticsProperties.IsTraversalGroup) == true || SemanticsActions.OnClick in config

private fun PuppetContract.actions(config: SemanticsConfiguration): List<String> = buildList {
    // A hosted field takes a tap the way any text field does: it focuses.
    if (SemanticsActions.OnClick in config || PuppetHostedFieldKey in config) add("tap")
    if (SemanticsActions.OnLongClick in config) add("hold")
    if (SemanticsActions.ScrollBy in config) add("scroll")
}

/** One `/tree` node, or null for a pure layout node: no text, no test tag and no action. */
internal fun PuppetContract.treeNode(config: SemanticsConfiguration, rect: IntRect): JSONObject? {
    val hosted = config.getOrNull(PuppetHostedFieldKey)?.invoke()
    // A field reads its label (Text), then what it holds: the CLI finds `→ Verb` by a leading label.
    val text = listOfNotNull(
        listOfNotNull(
            config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text },
            config.getOrNull(SemanticsProperties.EditableText)?.text ?: hosted?.text,
        ).map(String::trim).filter(String::isNotEmpty).joinToString(" "),
        config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ") ?: hosted?.description,
    ).map(String::trim).firstOrNull(String::isNotEmpty).orEmpty()
    val tag = config.getOrNull(SemanticsProperties.TestTag)
    val actions = actions(config)
    if (text.isEmpty() && tag == null && actions.isEmpty()) return null
    val role = when (config.getOrNull(SemanticsProperties.Role)) {
        Role.Button -> "button"
        Role.Checkbox -> "checkbox"
        Role.Switch -> "switch"
        Role.RadioButton -> "radio"
        Role.Tab -> "tab"
        Role.Image -> "image"
        Role.DropdownList -> "dropdown"
        else -> when {
            SemanticsProperties.EditableText in config || hosted != null -> "field"
            SemanticsProperties.Heading in config -> "heading"
            tag != null && (tag.startsWith("note:") || tag.startsWith("folder:")) -> "row"
            SemanticsActions.OnClick in config -> "button"
            else -> "text"
        }
    }
    val flags = buildList {
        if (SemanticsProperties.Disabled in config) add("disabled")
        if (config.getOrNull(SemanticsProperties.Selected) == true) add("selected")
        if (config.getOrNull(SemanticsProperties.ToggleableState) == ToggleableState.On) add("checked")
        if (config.getOrNull(SemanticsProperties.Focused) == true || hosted?.focused == true) add("focused")
    }
    return JSONObject()
        .put("role", role)
        .put("text", text)
        .put("id", tag ?: JSONObject.NULL)
        .put("x", rect.left)
        .put("y", rect.top)
        .put("w", rect.width)
        .put("h", rect.height)
        .put("actions", JSONArray(actions))
        .put("flags", JSONArray(flags))
}
