package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mason (job 11 B): a tap that selects a block and raises the keyboard leaves the block in view above the keyboard; a
 * block taller than the space keeps its header in view.
 */
class TextFirstCodeBlockRevealTest {
    private suspend fun await(what: String, done: () -> Boolean) {
        val until = System.currentTimeMillis() + 5_000
        while (!done()) {
            check(System.currentTimeMillis() < until) { "no $what in 5 s" }
            delay(20)
        }
    }

    private val prose = (1..30).joinToString("\n\n") { "line $it of prose" }

    private suspend fun tapHeaderNearTheBottom(c: TextFirstController, codeLine: String): Pair<Int, Int> {
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        val start = view.editableText.indexOf(codeLine)
        await("a layout") { view.layout != null }
        val headerTop = view.layout.getLineTop(view.layout.getLineForOffset(start))
        // The header a little above the view's bottom, where the keyboard will rise over it.
        view.scrollTo(0, (view.totalPaddingTop + headerTop - (view.height - view.style.codeHeaderHeight * 2).toInt()).coerceAtLeast(0))
        await("the header drawn") { view.invalidate(); view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK) != null }
        val area = view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK)!!
        val headerOnScreen = view.totalPaddingTop - view.scrollY + area.top
        tapNoteAt(view, view.totalPaddingLeft + area.left + area.width() * 0.6f, view.totalPaddingTop - view.scrollY + area.centerY())
        await("the block selected") { view.selectedCodeBlock != null }
        // The keyboard rises over the header: the window shrinks to above it, as the keyboard's resize does.
        val params = view.layoutParams
        params.height = (headerOnScreen - view.lineHeight).toInt()
        view.layoutParams = params
        await("the note's resize") { view.height == params.height }
        delay(500)
        val visibleBottom = view.height
        val (top, bottom) = view.codeBlockLines(view.selectedCodeBlock!!)!!
        val onScreen = view.totalPaddingTop - view.scrollY
        assertTrue("the block's top is above the view (${top + onScreen})", top + onScreen >= 0)
        assertTrue("the header (${top + onScreen}) is under the keyboard at $visibleBottom", top + onScreen + view.style.codeHeaderHeight <= visibleBottom)
        return (bottom + onScreen) to visibleBottom
    }

    @Test fun aTappedBlockNearTheBottomShowsWholeAboveTheKeyboard() = textFirstSession("$prose\n\n```js\nconst a = 1\nconst b = 2\n```\n\nend") { c ->
        val (bottom, visible) = tapHeaderNearTheBottom(c, "const a")
        assertTrue("the block ends at $bottom, under the keyboard at $visible", bottom <= visible)
    }

    @Test fun aTappedBlockTallerThanTheSpaceKeepsItsHeaderInView() = textFirstSession(
        "$prose\n\n```js\n" + (1..60).joinToString("\n") { "const x$it = $it" } + "\n```\n\nend",
    ) { c ->
        val (bottom, visible) = tapHeaderNearTheBottom(c, "const x1 ")
        assertTrue("the block's end ($bottom) should run past the keyboard ($visible): it is taller than the space", bottom > visible)
    }

    /** Sol review (job 14, 6): a tap on the header of a block already selected, partly under the note's edge, shows it. */
    @Test fun aRetapOnASelectedBlockPartlyHiddenShowsIt() = textFirstSession("$prose\n\n```js\nconst a = 1\nconst b = 2\n```\n\nend") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        view.requestFocus()
        val start = view.editableText.indexOf("const a")
        await("a layout") { view.layout != null && view.text?.contains("end") == true }
        val l = view.layout
        view.scrollTo(0, view.totalPaddingTop + l.getLineTop(l.getLineForOffset(start)) - view.height / 2)
        await("the header drawn") { view.invalidate(); view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK) != null }
        var area = view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK)!!
        tapNoteAt(view, view.totalPaddingLeft + area.left + area.width() * 0.6f, view.totalPaddingTop - view.scrollY + area.centerY())
        await("the block selected") { view.selectedCodeBlock != null }
        delay(300)
        // The block's last line under the note's bottom edge, its header still on screen.
        val (_, bottom) = view.codeBlockLines(view.selectedCodeBlock!!)!!
        view.scrollTo(0, view.totalPaddingTop + bottom - view.height + view.totalPaddingBottom + view.lineHeight)
        delay(300)
        await("the header drawn again") { view.invalidate(); view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK) != null }
        area = view.codeChrome.areaOf(start, CodeBlockAction.SELECT_BLOCK)!!
        tapNoteAt(view, view.totalPaddingLeft + area.left + area.width() * 0.6f, view.totalPaddingTop - view.scrollY + area.centerY())
        delay(600)
        val shown = view.totalPaddingTop - view.scrollY + bottom
        assertTrue("the block ends at $shown, under the edge at ${view.height - view.totalPaddingBottom}", shown <= view.height - view.totalPaddingBottom + 1)
    }
}
