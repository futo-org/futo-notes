package com.futo.notes.editor

import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.*

class NativeEditorBlockRegressionTest {
    @Test
    fun sharedListsPreserveHistoryCaretsAndRecovery() = sharedListActions()

    private data class Case(val opening: String, val command: EditorBlockCommand, val expected: String, val shown: String, val caret: ULong)

    @Test
    fun fencedCodeExposesLanguageAndRecoversExactOpaqueUnicodeContents() {
        runNativeEditorFenceContract()
    }

    @Test
    fun sharedBlockCommandsProjectStructureAndRecoverExactBytes() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-blocks-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                store.createNote("blocks", "", "😀ab\r\ntail  \r\n")
                store.openEditor("blocks").use { session ->
                    val heading = session.blockCommandUtf16(0uL, EditorUtf16Range(2uL, 2uL), EditorBlockCommand.Heading(6u))
                    assertEquals(6.toUByte(), heading!!.projection.blocks.first().heading)
                    assertEquals("###### 😀ab\r\ntail  \r\n", session.sourceText())
                    session.paragraphKeyUtf16(1uL, EditorUtf16Range(3uL, 3uL), EditorParagraphKey.ENTER)
                    assertEquals("###### 😀a\nb\r\ntail  \r\n", session.sourceText())
                    session.undo(2uL)
                    session.redo(3uL)
                    session.flushRecovery()
                    session.detach()
                }
                store.openEditor("blocks").use { recovered ->
                    assertEquals("###### 😀a\nb\r\ntail  \r\n", recovered.sourceText())
                    recovered.checkpoint()
                    assertEquals("###### 😀a\nb\r\ntail  \r\n", store.read("blocks"))
                    recovered.detach()
                }
                store.createNote("quote", "", "> a")
                store.openEditor("quote").use { quote ->
                    quote.blockCommandUtf16(0uL, EditorUtf16Range(1uL, 1uL), EditorBlockCommand.Indent)
                    assertEquals("> > a", quote.sourceText())
                    quote.blockCommandUtf16(1uL, EditorUtf16Range(1uL, 1uL), EditorBlockCommand.Outdent)
                    assertEquals("> a", quote.sourceText())
                    assertNull(quote.blockCommandUtf16(2uL, EditorUtf16Range(1uL, 1uL), EditorBlockCommand.Quote))
                    val divider = quote.blockCommandUtf16(2uL, EditorUtf16Range(1uL, 1uL), EditorBlockCommand.Divider)
                    assertTrue(divider!!.projection.blocks.any { it.divider })
                    assertEquals("> a\n> ***\n> ", quote.sourceText())
                    assertEquals("a\n\ufffc\n", quote.displayText())
                    quote.flushRecovery()
                    quote.detach()
                }
                store.openEditor("quote").use { recovered ->
                    assertEquals("> a\n> ***\n> ", recovered.sourceText())
                    recovered.checkpoint()
                    recovered.detach()
                }
                store.createNote("shortcut", "", "\\#A #\r\ntail  ")
                store.openEditor("shortcut").use { shortcut ->
                    shortcut.selectUtf16(0uL, EditorUtf16Range(1uL, 1uL))
                    val converted = shortcut.replaceUtf16(0uL, EditorUtf16Range(1uL, 1uL), listOf(32u.toUShort()))
                    assertEquals(EditorByteRange(0uL, 0uL), converted.selection)
                    assertEquals("# A \\#\r\ntail  ", shortcut.sourceText())
                    assertEquals("A #\r\ntail  ", shortcut.displayText())
                    shortcut.undo(1uL)
                    assertEquals("\\#A #\r\ntail  ", shortcut.sourceText())
                    shortcut.redo(2uL)
                    shortcut.flushRecovery()
                    shortcut.detach()
                }
                store.openEditor("shortcut").use { recovered ->
                    assertEquals("# A \\#\r\ntail  ", recovered.sourceText())
                    recovered.checkpoint()
                    assertEquals("# A \\#\r\ntail  ", store.read("shortcut"))
                    recovered.detach()
                }
                store.createNote("carry", "", "# __ab__")
                store.openEditor("carry").use { carry ->
                    carry.paragraphKeyUtf16(0uL, EditorUtf16Range(2uL, 2uL), EditorParagraphKey.ENTER)
                    assertEquals(listOf(EditorInlineFormat.BOLD), carry.activeFormats())
                    carry.replaceUtf16(1uL, EditorUtf16Range(3uL, 3uL), listOf(99u.toUShort()))
                    assertEquals("# __ab__\n__c__", carry.sourceText())
                    assertEquals("ab\nc", carry.displayText())
                    carry.flushRecovery()
                    carry.detach()
                }
                store.openEditor("carry").use { recovered ->
                    assertEquals("# __ab__\n__c__", recovered.sourceText())
                    recovered.checkpoint()
                    assertEquals("# __ab__\n__c__", store.read("carry"))
                    recovered.detach()
                }
            }
        } finally { root.deleteRecursively() }
    }

    @Test
    fun blockConversionsPreserveSpacesQuoteDepthAndPhysicalSetextPrefixes() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-block-regressions-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                val cases = listOf(
                    Case("   foo", EditorBlockCommand.Heading(2u), "## &#32;  foo", "   foo", 6uL),
                    Case("   # foo", EditorBlockCommand.Heading(0u), "foo", "foo", 0uL),
                    Case("> > ## 猫🦊 ##", EditorBlockCommand.Quote, "> > 猫🦊", "猫🦊", 0uL),
                    Case("> foo\r\n> bar\r\n> ===", EditorBlockCommand.Heading(0u), "> foo\r\n> bar", "foo\r\nbar", 5uL),
                )
                cases.forEachIndexed { index, case ->
                    val id = "block-$index"
                    store.createNote(id, "", case.opening)
                    store.openEditor(id).use { session ->
                        assertEquals(case.shown, session.displayText())
                        val change = checkNotNull(session.blockCommandUtf16(0uL, EditorUtf16Range(case.caret, case.caret), case.command))
                        assertEquals(case.expected, session.sourceText())
                        assertEquals(case.shown, session.displayText())
                        assertEquals(EditorByteRange(case.caret, case.caret), change.selection)
                        session.undo(1uL)
                        assertEquals(case.opening, session.sourceText())
                        session.redo(2uL)
                        session.flushRecovery()
                        session.detach()
                    }
                    store.openEditor(id).use { recovered ->
                        assertEquals(case.expected, recovered.sourceText())
                        assertEquals(case.shown, recovered.displayText())
                        recovered.checkpoint()
                        assertEquals(case.expected, store.read(id))
                        recovered.detach()
                    }
                }
            }
        } finally { root.deleteRecursively() }
    }
    @Test
    fun setextPhysicalOwnershipAndHeadingEnterPreserveNativeRangesAndRecovery() {
        data class Case(val opening: String, val shown: String, val action: String, val start: ULong,
                        val end: ULong, val expected: String, val display: String, val caret: ULong)
        val cases = listOf(
            Case("#x\n=", "#x", "text", 0uL, 2uL, "#x", "#x", 2uL),
            Case("> x\n> y\n> =", "x\ny", "indent", 0uL, 3uL, "> > x\n> > y\n> > =", "x\ny", 3uL),
            Case("> > x\r\n> > y\r\n> > ---", "x\r\ny", "outdent", 0uL, 4uL,
                 "> x\r\n> y\r\n> ---", "x\r\ny", 4uL),
            Case("> > 猫🦊\r\n> > e\u0301\r\n> > ===", "猫🦊\r\ne\u0301", "enter", 5uL, 5uL,
                 "> > 猫🦊\r\n> > ===\r\n\n> > e\u0301", "猫🦊\r\n\ne\u0301", 6uL),
            Case("> # x", "x", "enter", 0uL, 1uL, "> # \n> ", "\n", 1uL),
            Case("> x\n> =", "x", "enter", 0uL, 1uL, "> # \n> ", "\n", 1uL),
            Case("> x\n> =", "x", "delete", 0uL, 1uL, "> # ", "", 0uL),
        )
        for (case in cases) {
            val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-setext-${UUID.randomUUID()}")
            check(root.mkdirs())
            try {
                NoteStore(root.absolutePath).use { store ->
                    store.createNote("setext", "", case.opening)
                    store.openEditor("setext").use { session ->
                        assertEquals(case.shown, session.displayText())
                        val selected = EditorUtf16Range(case.start, case.end)
                        session.selectUtf16(0uL, selected)
                        val change = checkNotNull(when (case.action) {
                            "enter" -> session.paragraphKeyUtf16(0uL, selected, EditorParagraphKey.ENTER)
                            "delete" -> session.replaceUtf16(0uL, selected, emptyList())
                            else -> session.blockCommandUtf16(0uL, selected, when (case.action) {
                                "text" -> EditorBlockCommand.Heading(0u)
                                "indent" -> EditorBlockCommand.Indent
                                else -> EditorBlockCommand.Outdent
                            })
                        })
                        val before = case.shown.toByteArray(Charsets.UTF_8)
                        val view = before.copyOfRange(0, change.range.start.toInt()) + change.inserted.toByteArray(Charsets.UTF_8) + before.copyOfRange(change.range.end.toInt(), before.size)
                        assertEquals(case.display, view.toString(Charsets.UTF_8))
                        assertEquals(case.expected, session.sourceText())
                        assertEquals(case.caret, session.displayToUtf16(1uL, change.selection).end)
                        session.undo(1uL)
                        assertEquals(case.opening, session.sourceText())
                        session.redo(2uL)
                        assertEquals(case.expected, session.sourceText())
                        session.flushRecovery()
                        session.detach()
                    }
                    store.openEditor("setext").use { recovered ->
                        assertEquals(case.expected, recovered.sourceText())
                        assertEquals(case.display, recovered.displayText())
                        recovered.checkpoint()
                        assertEquals(case.expected, store.read("setext"))
                        recovered.detach()
                    }
                }
            } finally { root.deleteRecursively() }
        }
    }

    @Test
    fun completeBlockBodiesAndReturnedCaretsSurviveExactRecovery() {
        data class Case(val opening: String, val shown: String, val action: String, val start: ULong,
                        val end: ULong, val expected: String, val display: String, val followup: Boolean)
        val cases = listOf(
            Case("> a\n> b\n> =", "a\nb", "divider", 0uL, 0uL, "> ---\n> \n> a\n> b\n> =", "\ufffc\n\na\nb", false),
            Case("> a\n> b\n> =", "a\nb", "divider", 0uL, 3uL, "> ---\n> ", "\ufffc\n", false),
            Case("> 猫🦊\n> e\u0301z\n> ===", "猫🦊\ne\u0301z", "divider", 7uL, 7uL, "> 猫🦊\n> e\u0301z\n> ===\n> ***\n> ", "猫🦊\ne\u0301z\n\ufffc\n", false),
            Case("a\nb\n===", "a\nb", "heading", 0uL, 3uL, "### a b", "a b", false),
            Case("> ab ##\n> cd ###\n> ===", "ab ##\ncd ###", "heading", 0uL, 12uL, "> ### ab ## cd \\###", "ab ## cd ###", false),
            Case("## x y", "x y", "delete", 0uL, 0uL, "## &#32;y", " y", false),
            Case("## # ab", "# ab", "delete", 0uL, 0uL, "## &#32;ab", " ab", false),
            Case("#x\n=", "#x", "backspace", 2uL, 2uL, "\\#\n=", "#", false),
            Case("## x", "x", "space", 0uL, 1uL, "## &#32;", " ", false),
            Case("x\n=", "x", "newline", 0uL, 1uL, "# \n", "\n", false),
            Case("> __ab\n> cd__", "ab\ncd", "enter", 1uL, 1uL, "> __a__\n>\n> __!b__\n> __cd__", "a\n\n!b\ncd", true),
            Case("> __ab\n> cd__\n> ===", "ab\ncd", "enter", 1uL, 1uL, "> __a__\n> ===\n> __!b\n> cd__", "a\n!b\ncd", true),
            Case("> `ab`\n> `cd`\n> ---", "ab\ncd", "delete", 3uL, 3uL, "> `ab`\n> `!d`\n> ---", "ab\n!d", true),
            Case("> ab\ncd\n> ===", "ab\ncd", "divider", 1uL, 4uL, "> a\n> ===\n> ***\n> \n> d\n> ===", "a\n\ufffc\n\nd", false),
            Case("> ## # ab ##\n> ## cd ###", "# ab\ncd", "delete", 0uL, 7uL, "> ##  ! ###", "!", true),
            Case("> ab\n> ===", "ab", "space", 0uL, 2uL, "> # &#32;", " ", false)
        )
        for (case in cases) {
            val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-owned-body-${UUID.randomUUID()}")
            check(root.mkdirs())
            try {
                NoteStore(root.absolutePath).use { store ->
                    store.createNote("body", "", case.opening)
                    store.openEditor("body").use { session ->
                        val selected = EditorUtf16Range(case.start, case.end)
                        session.selectUtf16(0uL, selected)
                        val change = when (case.action) {
                            "heading", "divider" -> checkNotNull(session.blockCommandUtf16(0uL, selected, if (case.action == "heading") EditorBlockCommand.Heading(3u) else EditorBlockCommand.Divider))
                            "space", "newline" -> session.replaceUtf16Action(0uL, selected, if (case.action == "space") listOf(32u.toUShort()) else listOf(10u.toUShort()), EditorInputAction.ISOLATED)
                            else -> checkNotNull(session.paragraphKeyUtf16(0uL, selected, when (case.action) { "enter" -> EditorParagraphKey.ENTER; "delete" -> EditorParagraphKey.DELETE; else -> EditorParagraphKey.BACKSPACE }))
                        }
                        var view = case.shown.toByteArray(Charsets.UTF_8)
                        fun apply(delta: EditorViewChange) { view = view.copyOfRange(0, delta.range.start.toInt()) + delta.inserted.toByteArray(Charsets.UTF_8) + view.copyOfRange(delta.range.end.toInt(), view.size) }
                        apply(change)
                        if (case.followup) {
                            val caret = session.displayToUtf16(1uL, change.selection)
                            apply(session.replaceUtf16Action(1uL, caret, listOf(33u.toUShort()), EditorInputAction.ISOLATED))
                        }
                        assertEquals(case.display, view.toString(Charsets.UTF_8))
                        assertEquals(case.expected, session.sourceText())
                        session.undo(session.revision())
                        if (case.followup) session.undo(session.revision())
                        assertEquals(case.opening, session.sourceText())
                        session.redo(session.revision())
                        if (case.followup) session.redo(session.revision())
                        assertEquals(case.expected, session.sourceText())
                        session.flushRecovery()
                        session.detach()
                    }
                    store.openEditor("body").use { recovered ->
                        assertEquals(case.expected, recovered.sourceText())
                        assertEquals(case.display, recovered.displayText())
                        recovered.checkpoint()
                        assertEquals(case.expected, store.read("body"))
                        recovered.detach()
                    }
                }
            } finally { root.deleteRecursively() }
        }
    }

}
