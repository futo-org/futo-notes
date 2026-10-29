package com.futo.notes.editor

import android.os.Process
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.*

/** A small real Kotlin consumer; no replacement view or markdown policy. */
class NativeEditorSessionTest {
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
                    carry.selectUtf16(0uL, EditorUtf16Range(2uL, 2uL))
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
    fun paragraphKeysPreservePlatformRangesExactLineEndingsAndRecovery() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-lines-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                store.createNote("lines", "", "__a😀b__\r\ntail  \r\n")
                store.openEditor("lines").use { session ->
                    session.selectUtf16(0uL, EditorUtf16Range(8uL, 8uL))
                    var view = "a😀b\r\ntail  \r\n".toByteArray(Charsets.UTF_8)
                    fun apply(change: EditorViewChange?) {
                        checkNotNull(change)
                        view = view.copyOfRange(0, change.range.start.toInt()) + change.inserted.toByteArray(Charsets.UTF_8) + view.copyOfRange(change.range.end.toInt(), view.size)
                    }
                    apply(session.paragraphKeyUtf16(0uL, EditorUtf16Range(3uL, 3uL), EditorParagraphKey.SHIFT_ENTER))
                    assertEquals("a😀\nb\r\ntail  \r\n", view.toString(Charsets.UTF_8))
                    assertEquals("__a😀\nb__\r\ntail  \r\n", session.sourceText())
                    apply(session.paragraphKeyUtf16(1uL, EditorUtf16Range(4uL, 4uL), EditorParagraphKey.BACKSPACE))
                    assertEquals("a😀b\r\ntail  \r\n", view.toString(Charsets.UTF_8))
                    apply(session.undo(2uL))
                    assertEquals("__a😀\nb__\r\ntail  \r\n", session.sourceText())
                    session.flushRecovery()
                    session.detach()
                }
                store.openEditor("lines").use { recovered ->
                    assertEquals("__a😀\nb__\r\ntail  \r\n", recovered.sourceText())
                    recovered.checkpoint()
                    assertEquals("__a😀\nb__\r\ntail  \r\n", store.read("lines"))
                    recovered.detach()
                }
            }
        } finally { root.deleteRecursively() }
    }

    @Test
    fun staleOversizedForeignRangeKeepsCanonicalFailurePrecedence() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-wide-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                store.createNote("plain", "", "a")
                store.openEditor("plain").use { session ->
                    session.replaceUtf16(0uL, EditorUtf16Range(1uL, 1uL), listOf(33u.toUShort()))
                    try {
                        session.replaceUtf16(0uL, EditorUtf16Range(0x100000000uL, 0x100000000uL), listOf(65u.toUShort()))
                        fail("Stale input was accepted")
                    } catch (error: EditorSessionException.StaleRevision) {
                        assertEquals(0uL, error.expected)
                        assertEquals(1uL, error.actual)
                    }
                    assertEquals("a!", session.sourceText())
                    session.detach()
                }
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun readCreateAndSymlinkSafetyUseSupportedFilesystemCalls() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-fs-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            File(root, "probe.md").writeText("probe")
            NoteStore(root.absolutePath).use { store ->
                assertEquals("probe", store.read("probe"))
                assertTrue(store.exists("probe"))
                store.createNote("created", "", "created")
                assertEquals("created", store.read("created"))
                android.system.Os.symlink(File(root, "probe.md").absolutePath, File(root, "alias.md").absolutePath)
                try {
                    store.read("alias")
                    fail("A symlink note was followed")
                } catch (_: NoteException.Io) {}
                assertEquals("probe", File(root, "probe.md").readText())
            }
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun exactInputErrorsDeltasHistoryAndRecovery() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val require32 = InstrumentationRegistry.getArguments().getString("editorRequire32Bit") == "true"
        if (require32) assertFalse("This acceptance run requires a 32-bit native process", Process.is64Bit())
        println("EDITOR_NATIVE_CONTRACT_32BIT=${!Process.is64Bit()}")
        val root = File(instrumentation.targetContext.cacheDir, "editor-native-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                store.createNote("plain", "", "a😀\u0000z\r\n")
                val session = store.openEditor("plain")
                assertEquals("a😀\u0000z\r\n", session.sourceText())
                val selected = session.selectUtf16(0uL, EditorUtf16Range(1uL, 3uL))
                assertEquals(EditorByteRange(1uL, 5uL), selected.selection)
                assertEquals(EditorUtf16Range(1uL, 3uL), session.displayToUtf16(0uL, selected.selection))
                try {
                    session.replaceUtf16(0uL, EditorUtf16Range(1uL, 3uL), listOf(0xD800u.toUShort()))
                    fail("Malformed input was accepted")
                } catch (_: EditorSessionException.InvalidText) {}
                for (range in listOf(EditorUtf16Range(2uL, 3uL), EditorUtf16Range(0x100000000uL, 0x100000000uL))) {
                    try {
                        session.replaceUtf16(0uL, range, listOf(65u.toUShort()))
                        fail("Invalid range was accepted")
                    } catch (_: EditorSessionException.InvalidRange) {}
                }
                val change = session.replaceUtf16(0uL, EditorUtf16Range(1uL, 3uL), "🇯🇵\u0000".map { it.code.toUShort() })
                assertEquals(0uL, change.previousRevision)
                assertEquals(1uL, change.revision)
                assertEquals(EditorByteRange(1uL, 5uL), change.range)
                assertEquals("🇯🇵\u0000", change.inserted)
                assertEquals(EditorByteRange(10uL, 10uL), change.selection)
                val before = "a😀\u0000z\r\n".toByteArray(Charsets.UTF_8)
                val view = before.copyOfRange(0, change.range.start.toInt()) + change.inserted.toByteArray(Charsets.UTF_8) + before.copyOfRange(change.range.end.toInt(), before.size)
                assertEquals("a🇯🇵\u0000\u0000z\r\n", String(view, Charsets.UTF_8))
                assertEquals("a🇯🇵\u0000\u0000z\r\n", session.displayText())
                try {
                    session.replaceUtf16(0uL, EditorUtf16Range(0uL, 0uL), listOf(65u.toUShort()))
                    fail("Stale input was accepted")
                } catch (error: EditorSessionException.StaleRevision) {
                    assertEquals(0uL, error.expected)
                    assertEquals(1uL, error.actual)
                }
                session.undo(1uL)
                assertEquals("a😀\u0000z\r\n", session.sourceText())
                session.redo(2uL)
                assertEquals(3uL, session.flushRecovery().durable)
                session.detach()
                session.destroy()
                store.openEditor("plain").use { recovered ->
                    assertEquals("a🇯🇵\u0000\u0000z\r\n", recovered.sourceText())
                    assertEquals(3uL, recovered.revision())
                    assertEquals("plain", recovered.checkpoint().mutation?.finalId)
                    assertEquals("a🇯🇵\u0000\u0000z\r\n", store.read("plain"))
                    recovered.detach()
                }
                store.createNote("inline", "", "__日😀__ tail\r\n")
                store.openEditor("inline").use { inline ->
                    val projected = inline.project(0uL, EditorByteRange(0uL, 14uL))
                    assertEquals("日😀 tail\r\n", projected.text)
                    assertEquals(listOf(EditorInlineFormat.BOLD), projected.runs.first().formats)
                    inline.detach()
                }
                store.createNote("entity", "", "&acE;")
                store.openEditor("entity").use { entity ->
                    assertEquals("∾\u0333", entity.displayText())
                    assertEquals(0uL, entity.sourceAt(0uL, EditorDisplayByteOffset(3uL), EditorAffinity.BACKWARD).offset)
                    assertEquals(5uL, entity.sourceAt(0uL, EditorDisplayByteOffset(3uL), EditorAffinity.FORWARD).offset)
                    entity.detach()
                }

            }
        } finally {
            root.deleteRecursively()
        }
    }
    @Test
    fun isolatedCommitsAndCompoundReplacementsPreserveExactHistory() {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-history-${UUID.randomUUID()}")
        check(root.mkdirs())
        try {
            NoteStore(root.absolutePath).use { store ->
                val opening = "__cat__ &amp; _dog_\r\n"
                store.createNote("history", "", opening)
                store.openEditor("history").use { session ->
                    var view = "cat & dog\r\n".toByteArray(Charsets.UTF_8)
                    var revision = 0uL
                    fun apply(change: EditorViewChange) {
                        assertEquals(revision, change.previousRevision)
                        assertEquals(revision + 1uL, change.revision)
                        view = view.copyOfRange(0, change.range.start.toInt()) + change.inserted.toByteArray(Charsets.UTF_8) + view.copyOfRange(change.range.end.toInt(), view.size)
                        revision = change.revision
                    }
                    fun units(text: String) = text.map { it.code.toUShort() }
                    session.selectWithAffinity(0uL, EditorByteRange(0uL, 3uL), EditorAffinity.FORWARD)
                    apply(checkNotNull(session.toggleFormat(0uL, EditorInlineFormat.ITALIC)))
                    assertEquals("*__cat__* &amp; _dog_\r\n", session.sourceText())
                    apply(session.replaceManyUtf16(1uL, listOf(
                        EditorUtf16Replacement(EditorUtf16Range(0uL, 3uL), units("kitten")),
                        EditorUtf16Replacement(EditorUtf16Range(6uL, 9uL), units("ox")),
                    )))
                    assertEquals("*__kitten__* &amp; _ox_\r\n", session.sourceText())
                    apply(session.replaceUtf16Action(2uL, EditorUtf16Range(11uL, 11uL), units("日本"), EditorInputAction.COMPOSITION_COMMIT))
                    assertEquals("*__kitten__* &amp; _ox日本_\r\n", session.sourceText())
                    apply(session.replaceUtf16Action(3uL, EditorUtf16Range(13uL, 13uL), listOf(33u.toUShort()), EditorInputAction.ISOLATED))
                    val final = "*__kitten__* &amp; _ox日本!_\r\n"
                    assertEquals(final, session.sourceText())
                    assertEquals("kitten & ox日本!\r\n", String(view, Charsets.UTF_8))
                    for (expected in listOf("*__kitten__* &amp; _ox日本_\r\n", "*__kitten__* &amp; _ox_\r\n", "*__cat__* &amp; _dog_\r\n", opening)) {
                        apply(checkNotNull(session.undo(revision)))
                        assertEquals(expected, session.sourceText())
                    }
                    assertEquals("cat & dog\r\n", String(view, Charsets.UTF_8))
                    assertNull(session.undo(8uL))
                    for (expected in listOf("*__cat__* &amp; _dog_\r\n", "*__kitten__* &amp; _ox_\r\n", "*__kitten__* &amp; _ox日本_\r\n", final)) {
                        apply(checkNotNull(session.redo(revision)))
                        assertEquals(expected, session.sourceText())
                    }
                    assertEquals(listOf(EditorInlineFormat.ITALIC), session.activeFormats())
                    try {
                        session.replaceManyUtf16(12uL, listOf(
                            EditorUtf16Replacement(EditorUtf16Range(0uL, 6uL), listOf(97u.toUShort())),
                            EditorUtf16Replacement(EditorUtf16Range(9uL, 11uL), listOf(0xD800u.toUShort())),
                        ))
                        fail("A malformed later run was accepted")
                    } catch (_: EditorSessionException.InvalidText) {}
                    assertEquals(final, session.sourceText())
                    assertEquals(12uL, session.revision())
                    assertEquals(12uL, session.flushRecovery().durable)
                    session.detach()
                    store.openEditor("history").use { recovered ->
                        assertEquals(final, recovered.sourceText())
                        assertNull(recovered.undo(12uL))
                        assertEquals("history", recovered.checkpoint().mutation?.finalId)
                        assertEquals(final, store.read("history"))
                        recovered.detach()
                    }
                    store.createNote("echo", "", "__a__")
                    store.openEditor("echo").use { echo ->
                        echo.selectWithAffinity(0uL, EditorByteRange(1uL, 1uL), EditorAffinity.BACKWARD)
                        echo.replaceUtf16(0uL, EditorUtf16Range(1uL, 1uL), listOf(32u.toUShort()))
                        echo.selectWithAffinity(1uL, EditorByteRange(2uL, 2uL), EditorAffinity.BACKWARD)
                        echo.replaceUtf16Action(1uL, EditorUtf16Range(2uL, 2uL), listOf(98u.toUShort()), EditorInputAction.TYPING)
                        assertEquals("__a b__", echo.sourceText())
                        assertEquals(listOf(EditorInlineFormat.BOLD), echo.activeFormats())
                        echo.detach()
                    }

                }
            }
        } finally {
            root.deleteRecursively()
        }
    }

}
