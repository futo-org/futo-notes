package com.futo.notes.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * RC-71 follow-up: the relink adopt is "replace the page's document with the
 * relinked body IF it still holds the text the shell read". A read and a replace
 * are two renderer round trips, and a keystroke landing between them was
 * destroyed; the compare and the replace are one script now. No JS engine runs in
 * a JVM unit test, so the script's shape is pinned here and its behaviour is
 * exercised on the device (tests/android-editor-stories.mjs).
 */
class ExternalAdoptionTest {
    @Test
    fun `the compare and the replace are one script, compare first`() {
        val script = adoptIfUnchangedScript("back to [[Old]]", "back to [[New]]")

        val compare = script.indexOf("getContent()")
        val replace = script.indexOf("applyExternalContent(")
        assertTrue("script must compare: $script", compare >= 0)
        assertTrue("script must replace: $script", replace >= 0)
        assertTrue("the replace must follow the compare: $script", compare < replace)
        // Exactly one of each: a second read or replace would reopen the window.
        assertEquals(1, Regex("getContent\\(\\)").findAll(script).count())
        assertEquals(1, Regex("applyExternalContent\\(").findAll(script).count())
        // The replace sits behind the comparison's early return.
        assertTrue(script.indexOf("return JSON.stringify({ applied: false") in (compare + 1) until replace)
    }

    @Test
    fun `quotes, backslashes and newlines reach the script as string literals`() {
        val awkward = "say \"hi\" \\ and\n[[Old]]"
        val script = adoptIfUnchangedScript(awkward, "$awkward!")

        assertTrue(script.contains("\"say \\\"hi\\\" \\\\ and\\n[[Old]]\""))
        assertTrue(script.contains("\"say \\\"hi\\\" \\\\ and\\n[[Old]]!\""))
    }

    @Test
    fun `the answer is applied, kept with the live text, or undecided`() {
        assertEquals(ExternalAdoption.Applied, externalAdoptionFrom("""{"applied":true}"""))
        assertEquals(
            ExternalAdoption.Kept("see [[Old]]kk"),
            externalAdoptionFrom("""{"applied":false,"text":"see [[Old]]kk"}"""),
        )
        assertEquals(ExternalAdoption.Unavailable, externalAdoptionFrom(null))
        assertEquals(ExternalAdoption.Unavailable, externalAdoptionFrom("not json"))
        assertEquals(ExternalAdoption.Unavailable, externalAdoptionFrom("""{"applied":false}"""))
    }
}
