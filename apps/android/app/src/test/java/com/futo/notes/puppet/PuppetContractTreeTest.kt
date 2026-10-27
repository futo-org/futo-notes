package com.futo.notes.puppet

import androidx.compose.ui.semantics.AccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.ScrollAxisRange
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsConfiguration
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** `/tree`'s pure half: what a node is, what covers it, its section and its list (PuppetContractTree.kt). */
class PuppetContractTreeTest {
    @Test
    fun theTreesWebviewIsTheEditorsBoxWhenItIsUpAndNullOtherwise() {
        assertEquals(JSONObject.NULL, PuppetContract.webview(null))
        val editor = PuppetContract.webview(IntRect(0, 258, 720, 1552)) as JSONObject
        assertEquals(listOf(0, 258, 720, 1294), listOf("x", "y", "w", "h").map(editor::getInt))
    }

    private fun config(build: SemanticsConfiguration.() -> Unit) = SemanticsConfiguration().apply(build)

    private val tap = AccessibilityAction(null) { true }

    private val scrollBy = AccessibilityAction(null) { _: Float, _: Float -> true }

    private fun node(build: SemanticsConfiguration.() -> Unit) =
        PuppetContract.treeNode(config(build), IntRect(10, 20, 110, 70))!!

    private fun strings(node: JSONObject, key: String) =
        node.getJSONArray(key).let { array -> (0 until array.length()).map(array::getString) }

    @Test
    fun aNodeIsWhatItsSemanticsSayInTheCliVocabulary() {
        // A list row: its merged texts, its tag, a tap and a hold, and no role of its own.
        val row = node {
            set(SemanticsProperties.Text, listOf(AnnotatedString("Seed 01"), AnnotatedString("seed body")))
            set(SemanticsProperties.TestTag, "note:Seed 01")
            set(SemanticsActions.OnClick, tap)
            set(SemanticsActions.OnLongClick, tap)
        }
        assertEquals("row", row.getString("role"))
        assertEquals("Seed 01 seed body", row.getString("text"))
        assertEquals("note:Seed 01", row.getString("id"))
        assertEquals(listOf(10, 20, 100, 50), listOf("x", "y", "w", "h").map(row::getInt))
        assertEquals(listOf("tap", "hold"), strings(row, "actions"))
        // A Role outranks everything else.
        val toggle = node {
            set(SemanticsProperties.Role, Role.Switch)
            set(SemanticsProperties.ToggleableState, ToggleableState.On)
            set(SemanticsProperties.Disabled, Unit)
            set(SemanticsActions.OnClick, tap)
        }
        assertEquals("switch", toggle.getString("role"))
        assertEquals(listOf("disabled", "checked"), strings(toggle, "flags"))
        assert(toggle.isNull("id"))
        // A click with no role is a button, named by its trimmed description.
        val search = node {
            set(SemanticsProperties.ContentDescription, listOf(" Search "))
            set(SemanticsActions.OnClick, tap)
        }
        assertEquals(listOf("button", "Search"), listOf(search.getString("role"), search.getString("text")))
        // A field shows what is typed in it, and its description while it is empty.
        val field = node {
            set(SemanticsProperties.EditableText, AnnotatedString(""))
            set(SemanticsProperties.ContentDescription, listOf("Name"))
            set(SemanticsProperties.Focused, true)
        }
        assertEquals(listOf("field", "Name"), listOf(field.getString("role"), field.getString("text")))
        assertEquals(listOf("focused"), strings(field, "flags"))
        // An OutlinedTextField's label is its Text: it reads the label, then its value.
        fun labelled(value: String) = node {
            set(SemanticsProperties.Text, listOf(AnnotatedString("Name")))
            set(SemanticsProperties.EditableText, AnnotatedString(value))
        }.getString("text")
        assertEquals("Name wörk 🎒", labelled("wörk 🎒"))
        assertEquals("Name", labelled(""))
        // A classic Android field hosted in Compose (the find bar's) reads the same.
        var typed = ""
        val hosted = config { set(PuppetHostedFieldKey) { PuppetHostedField(typed, "Find in note", true) } }
        val empty = PuppetContract.treeNode(hosted, IntRect(0, 0, 10, 10))!!
        assertEquals(listOf("field", "Find in note"), listOf(empty.getString("role"), empty.getString("text")))
        assertEquals(listOf("tap"), strings(empty, "actions"))
        assertEquals(listOf("focused"), strings(empty, "flags"))
        typed = "lease"
        assertEquals("lease", PuppetContract.treeNode(hosted, IntRect(0, 0, 10, 10))!!.getString("text"))
        val tab = node {
            set(SemanticsProperties.Role, Role.Tab)
            set(SemanticsProperties.Selected, true)
            set(SemanticsActions.OnClick, tap)
        }
        assertEquals(listOf("tab", "selected"), listOf(tab.getString("role")) + strings(tab, "flags"))
        val heading = node {
            set(SemanticsProperties.Heading, Unit)
            set(SemanticsProperties.Text, listOf(AnnotatedString("Notes")))
        }
        assertEquals("heading", heading.getString("role"))
        val list = node { set(SemanticsActions.ScrollBy, scrollBy) }
        assertEquals(listOf("text", ""), listOf(list.getString("role"), list.getString("text")))
        assertEquals(listOf("scroll"), strings(list, "actions"))
        // A layout node (a Surface, a Column) is not a node of the tree.
        val surface = config { set(SemanticsProperties.IsTraversalGroup, true) }
        assertNull(PuppetContract.treeNode(surface, IntRect(0, 0, 10, 10)))
    }

    @Test
    fun aTapTargetIsOnlyWhereNothingDrawnOverItTakesTheTouch() {
        val seen = walk {
            node(IntRect(0, 0, 720, 1600), semantics = { set(SemanticsActions.ScrollBy, scrollBy) }) {
                row("note:under", 20)
                row("note:half", 100)
                row("note:clear", 400)
                text("RECENT", IntRect(40, 150, 120, 170))
            }
            // Placed after the list, so drawn over it: the top bar's Surface, then the FAB.
            node(IntRect(0, 0, 720, 176), semantics = { set(SemanticsProperties.IsTraversalGroup, true) })
            node(IntRect(572, 450, 684, 562), semantics = { set(SemanticsActions.OnClick, tap) })
        }
        val nodes = PuppetContract.tree(2f, IntSize(720, 1600), seen).getJSONArray("nodes")
        val found = (0 until nodes.length()).map(nodes::getJSONObject)
        assertEquals(
            "a row wholly under the bar is not on screen",
            listOf(null, "note:half", "note:clear", null, null),
            found.map { it.opt("id") as? String },
        )
        // The list and a row half under the bar start where the bar ends.
        assertEquals(listOf(176, 176), found.take(2).map { it.getInt("y") })
        assertEquals(243 - 176, found[1].getInt("h"))
        // The FAB covers a corner of this row, not a side, so its rect stands.
        assertEquals(143, found[2].getInt("h"))
        // Text is read, not tapped: the bar over it does not cut it.
        assertEquals("RECENT", found[3].getString("text"))
        assertEquals(150, found[3].getInt("y"))
    }


    /** A walk as the listener takes one: pre-order, each node's `end` just past its descendants. */
    private inner class Walk {
        val nodes = mutableListOf<PuppetContract.SeenNode>()

        fun node(
            rect: IntRect,
            window: Int = 0,
            semantics: SemanticsConfiguration.() -> Unit = {},
            inside: Walk.() -> Unit = {},
        ) {
            val node = PuppetContract.SeenNode(config(semantics), rect, window)
            nodes += node
            inside()
            node.end = nodes.size
        }

        fun text(label: String, rect: IntRect, window: Int = 0) =
            node(rect, window, { set(SemanticsProperties.Text, listOf(AnnotatedString(label))) })

        fun button(label: String, rect: IntRect, window: Int = 0, more: SemanticsConfiguration.() -> Unit = {}) =
            node(rect, window, {
                set(SemanticsProperties.ContentDescription, listOf(label))
                set(SemanticsActions.OnClick, tap)
                more()
            })

        fun row(tag: String, top: Int, height: Int = 143) = node(IntRect(32, top, 688, top + height), semantics = {
            set(SemanticsProperties.TestTag, tag)
            set(SemanticsActions.OnClick, tap)
        })

        fun scroller(rect: IntRect, window: Int = 0, range: SemanticsConfiguration.() -> Unit, inside: Walk.() -> Unit) =
            node(rect, window, { range(); set(SemanticsActions.ScrollBy, scrollBy) }, inside)
    }

    private fun walk(build: Walk.() -> Unit) = Walk().apply(build).nodes

    private fun range(value: Float, max: Float, reverse: Boolean = false) = ScrollAxisRange({ value }, { max }, reverse)

    private fun JSONArray.objects() = (0 until length()).map(::getJSONObject)

    /** Each listed node's section, by its id, else its text. */
    private fun sections(tree: JSONObject) = tree.getJSONArray("nodes").objects()
        .associate { ((it.opt("id") as? String) ?: it.getString("text")) to it.getString("section") }

    @Test
    fun aListScreenIsItsTopBarItsListAndWhatFloatsBelow() {
        val tree = PuppetContract.tree(
            2f,
            IntSize(720, 1600),
            walk {
                // The list fills the screen under the bar drawn over it, which is where it starts.
                scroller(IntRect(0, 48, 720, 1600), range = { set(SemanticsProperties.VerticalScrollAxisRange, range(0f, 100f)) }) {
                    row("note:under", 60, height = 100)
                    text("RECENT", IntRect(40, 180, 120, 200))
                    row("note:a", 200)
                    row("note:b", 400)
                }
                // The app bar says what it is; Search's row of controls does not, and is above the list.
                node(IntRect(0, 48, 720, 176), semantics = {
                    set(SemanticsProperties.IsTraversalGroup, true)
                    set(PuppetSection, "top bar")
                }) { text("Notes", IntRect(32, 90, 124, 133)) }
                button("Back", IntRect(16, 72, 96, 152))
                // Over the list's lower half, and over its upper half: neither is in it.
                button("New note", IntRect(572, 1404, 684, 1516))
                text("Saved", IntRect(200, 300, 500, 350))
            },
            rows = listOf("note:first", "note:under", "note:a", "note:b", "note:c"),
        )
        assertEquals(
            mapOf(
                "" to "list", "RECENT" to "list", "note:a" to "list", "note:b" to "list",
                "Notes" to "top bar", "Back" to "top bar", "New note" to "bottom bar", "Saved" to "content",
            ),
            sections(tree),
        )
        // The row wholly under the bar is not listed, so the rows on screen are the 3rd and 4th.
        val scroll = tree.getJSONArray("scroll").objects().single()
        assertEquals(
            listOf("list", false, true, false, false, 3, 4, 5),
            listOf("section", "up", "down", "left", "right", "first", "last", "total").map(scroll::get),
        )
    }

    @Test
    fun theEditorsBarsSayWhatTheyAreAndTheToolbarScrollsSideways() {
        val tree = PuppetContract.tree(
            2f,
            IntSize(720, 1600),
            walk {
                node(IntRect(0, 184, 720, 242), semantics = {
                    set(SemanticsProperties.EditableText, AnnotatedString("Seed 12"))
                })
                // Its buttons scroll inside it; the bar, not the scroller, is what they are in.
                node(IntRect(0, 913, 720, 1002), semantics = { set(PuppetSection, "keyboard toolbar") }) {
                    scroller(IntRect(0, 914, 596, 1002), range = {
                        set(SemanticsProperties.HorizontalScrollAxisRange, range(0f, 410f))
                    }) { button("Bold", IntRect(16, 914, 104, 1002)) }
                    button("Dismiss keyboard", IntRect(632, 914, 720, 1002))
                }
                node(IntRect(0, 48, 720, 176), semantics = { set(PuppetSection, "top bar") }) {
                    button("Back", IntRect(16, 72, 96, 152))
                }
            },
        )
        // No list here, so the title field is plain content.
        assertEquals(
            mapOf(
                "Seed 12" to "content", "" to "keyboard toolbar", "Bold" to "keyboard toolbar",
                "Dismiss keyboard" to "keyboard toolbar", "Back" to "top bar",
            ),
            sections(tree),
        )
        val scroll = tree.getJSONArray("scroll").objects().single()
        assertEquals(
            listOf("keyboard toolbar", false, false, false, true),
            listOf("section", "up", "down", "left", "right").map(scroll::get),
        )
        assertFalse("rows are counted only in a list of rows", scroll.has("total"))
    }

    @Test
    fun aDialogASheetAndAMenuPrefixWhatIsInThem() {
        val tree = PuppetContract.tree(
            2f,
            IntSize(720, 1600),
            walk {
                node(IntRect(80, 100, 640, 400), window = 0, semantics = { set(SemanticsProperties.IsDialog, Unit) }) {
                    text("Delete this note?", IntRect(128, 150, 383, 190), window = 0)
                    button("Delete", IntRect(446, 300, 592, 380), window = 0)
                }
                node(IntRect(0, 48, 720, 1600), window = 1, semantics = { set(SemanticsProperties.IsDialog, Unit) }) {
                    // A bottom sheet's handle dismisses it; nothing in a plain dialog does.
                    button("Drag handle", IntRect(328, 956, 392, 1052), window = 1) {
                        set(SemanticsActions.Dismiss, AccessibilityAction(null) { true })
                    }
                    scroller(IntRect(0, 1052, 720, 1552), window = 1, range = {
                        set(SemanticsProperties.VerticalScrollAxisRange, range(0f, 50f, reverse = true))
                    }) { button("Recipes", IntRect(0, 1094, 720, 1190), window = 1) }
                }
                node(IntRect(32, 740, 395, 900), window = 2, semantics = { set(SemanticsProperties.IsPopup, Unit) }) {
                    scroller(IntRect(32, 756, 395, 900), window = 2, range = {
                        set(SemanticsProperties.VerticalScrollAxisRange, range(0f, 0f))
                    }) { button("Move to folder…", IntRect(32, 756, 395, 852), window = 2) }
                }
            },
        )
        val sections = sections(tree)
        assertEquals(listOf("dialog", "dialog"), listOf(sections["Delete this note?"], sections["Delete"]))
        assertEquals(listOf("sheet · top bar", "sheet · list"), listOf(sections["Drag handle"], sections["Recipes"]))
        assertEquals("menu", sections["Move to folder…"])
        // The sheet's list is reversed, so more lies up. A menu reports no scrolling, as on iOS.
        val scroll = tree.getJSONArray("scroll").objects().single()
        assertEquals(
            listOf("sheet · list", true, false),
            listOf("section", "up", "down").map(scroll::get),
        )
    }

    /** A row's menu says which row its items act on (`puppetMenuFor`). */
    @Test
    fun aRowsMenuNamesTheRowItIsOpenFor() {
        val tree = PuppetContract.tree(
            2f,
            IntSize(720, 1600),
            walk {
                node(IntRect(32, 740, 395, 900), window = 1, semantics = { set(SemanticsProperties.IsPopup, Unit) }) {
                    node(IntRect(32, 740, 395, 900), window = 1, semantics = { set(PuppetSection, "note \"Welcome\"") }) {
                        button("Delete", IntRect(32, 756, 395, 852), window = 1)
                    }
                }
            },
        )
        assertEquals("menu · note \"Welcome\"", sections(tree)["Delete"])
    }
}
