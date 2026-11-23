package com.futo.notes.textfirst

import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Test

/** !300's language chip takes at most 30% of the header, drawn and while its field is open (one shared cap). */
class TextFirstCodeHeaderWidthTest {
    private val language = "averyveryverylonglanguagenamethatwouldcrowdtheheader"

    @Test fun aLongLanguageTakesAtMostThirtyPercentDrawnAndOpen() = textFirstSession("```$language\nconst a = 1\n```\n\nafter") { c ->
        val view = c.view
        view.isFocusableInTouchMode = true
        withTimeout(5_000) { while (view.layout == null) delay(20) }
        val start = view.editableText.indexOf("const")
        withTimeout(5_000) { while (view.codeChrome.areaOf(start, CodeBlockAction.LANGUAGE_LABEL) == null) delay(20) }
        val header = view.layout.width + view.style.codeCardOutset * 2
        val cap = header * CodeBlockChrome.LANGUAGE_SHARE
        val drawn = view.codeChrome.areaOf(start, CodeBlockAction.LANGUAGE_LABEL)!!
        assertTrue("drawn label ${drawn.width()} over the cap $cap", drawn.width() - view.style.codeChipPad <= cap + 1)
        holdNoteAt(view, view.totalPaddingLeft + drawn.centerX(), view.totalPaddingTop - view.scrollY + drawn.centerY())
        val field = openHeaderField(view)
        withTimeout(5_000) { while (field.width == 0) delay(20) }
        assertTrue("open field ${field.width} over the cap $cap", field.width <= cap + 1)
    }
}
