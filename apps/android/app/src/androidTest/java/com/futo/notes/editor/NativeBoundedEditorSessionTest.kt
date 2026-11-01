package com.futo.notes.editor

import android.os.Process
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.UUID
import org.junit.Assert.*
import org.junit.Test
import uniffi.futo_notes_ffi.*

/** A real page-owned consumer; Markdown meaning and recovery stay in Rust. */
class NativeBoundedEditorSessionTest {
    private fun vault(action: (NoteStore, File) -> Unit) {
        val root = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "editor-bounded-${UUID.randomUUID()}")
        check(root.mkdirs())
        try { NoteStore(root.absolutePath).use { action(it, root) } }
        finally { root.deleteRecursively() }
    }
    private fun index(offset: ULong): Int {
        require(offset <= Int.MAX_VALUE.toULong())
        return offset.toInt()
    }

    @Test
    fun boundedPageFramesRetainExactSourceSemanticsHistoryAndTheSameLease() = vault { store, _ ->
        val require32 = InstrumentationRegistry.getArguments().getString("editorRequire32Bit") == "true"
        if (require32) assertFalse("This acceptance run requires a 32-bit native process", Process.is64Bit())
        println("EDITOR_NATIVE_BOUNDED_32BIT=${!Process.is64Bit()}")
        val paragraph = "__😀__ &acE; [x](u) plain\n\n"
        val source = "prefix\n\n```Rust\nab\n```\n\n" + paragraph.repeat(8)
        store.createNote("plain", "", source)
        store.openEditor("plain").use { full ->
            full.replaceUtf16(0uL, EditorUtf16Range(8uL, 8uL), listOf(122u.toUShort()))
            var view = full.displayText().toByteArray(Charsets.UTF_8)
            full.intoBounded(1uL, 86uL, 8uL).use { bounded ->
                try { full.sourceText(); fail("old full alias accepted") }
                catch (_: EditorSessionException.Unavailable) {}
                try { store.openEditor("plain"); fail("bounded transfer released the lease") }
                catch (_: EditorSessionException.SessionAlreadyOpen) {}
                fun apply(range: EditorByteRange, inserted: String) {
                    view = view.copyOfRange(0, index(range.start)) + inserted.toByteArray(Charsets.UTF_8) + view.copyOfRange(index(range.end), view.size)
                }
                fun apply(frame: EditorBoundedProgress): EditorProjectionContinuation? = when (frame) {
                    is EditorBoundedProgress.Change -> {
                        val change = frame.change
                        apply(change.range, change.inserted)
                        assertEquals(0uL, change.work.parsedSourceBytes)
                        assertTrue(change.conversion.records > 0uL)
                        change.continuation
                    }
                    is EditorBoundedProgress.Status -> frame.status.continuation
                }
                fun finish(continuation: EditorProjectionContinuation?) {
                    var job = continuation
                    var steps = 0
                    while (job != null) {
                        job = apply(bounded.continueProjection(checkNotNull(job)))
                        check(++steps < 32)
                    }
                }
                val initial = bounded.cursor()
                // On actual32 an unchecked cast would wrap exactly to valid0.
                try { bounded.insertLiteral(initial, 0x100000000uL, 65u); fail("wide offset accepted") }
                catch (error: EditorBoundedException.Session) { assertTrue(error.error is EditorSessionException.InvalidRange) }
                try { bounded.insertLiteral(initial, 8uL, 0xD800u); fail("invalid scalar accepted") }
                catch (_: EditorBoundedException.InvalidScalar) {}
                assertEquals(0uL, bounded.lastOperationWork().work.metadataItems)
                assertEquals(0uL, bounded.lastOperationWork().work.copiedBytes)
                assertEquals(initial, bounded.cursor())
                val removed = bounded.removeFenceCloser(initial)
                apply(removed.range, removed.inserted)
                val stale = checkNotNull(removed.continuation)
                val displayed = view.toString(Charsets.UTF_8)
                val far = displayed.substring(0, displayed.lastIndexOf("plain") + 2).toByteArray(Charsets.UTF_8).size.toULong()
                apply(bounded.selectBounded(bounded.cursor(), EditorByteRange(far, far), EditorAffinity.BACKWARD))
                try { bounded.continueProjection(stale); fail("stale continuation accepted") }
                catch (_: EditorBoundedException.StaleCursor) {}
                assertEquals(0uL, bounded.lastOperationWork().work.metadataItems)
                val prefix = bounded.insertPrefixLiteral(bounded.cursor(), 1uL, 113u)
                apply(prefix.range, prefix.inserted)
                val code = bounded.insertLiteral(bounded.cursor(), 10uL, 0x1F600u)
                assertEquals(code.work.copiedBytes, bounded.lastOperationWork().work.copiedBytes)
                assertEquals(9uL, code.projection.block.owner)
                assertEquals(EditorByteRange(14uL, 14uL), code.selection)
                assertEquals(EditorAffinity.BACKWARD, code.affinity)
                assertEquals(EditorSourceByteRange(18uL, 22uL), code.projection.identity.source)
                apply(code.range, code.inserted)
                finish(code.continuation)
                var job: EditorProjectionContinuation? = null
                repeat(3) { job = apply(checkNotNull(bounded.undoBounded(bounded.cursor()))) }
                var atom = false
                var hidden = false
                var link = false
                var steps = 0
                while (job != null) {
                    val frame = bounded.continueProjection(checkNotNull(job))
                    if (frame is EditorBoundedProgress.Change) {
                        atom = atom || frame.change.projection.mapping.any { it.kind == EditorBoundedMapKind.ATOM }
                        hidden = hidden || frame.change.projection.mapping.any { it.kind == EditorBoundedMapKind.HIDDEN }
                        link = link || frame.change.projection.links.any { it.destination == "u" }
                    }
                    job = apply(frame)
                    check(++steps < 32)
                }
                assertTrue(atom && hidden && link)
                repeat(3) { job = apply(checkNotNull(bounded.redoBounded(bounded.cursor()))) }
                finish(job)
                val expected = "pqrefix\n\n```Rust\nz😀ab\n\n\n" + paragraph.repeat(8)
                val copy = bounded.acceptedSource()
                assertEquals(expected, copy.source)
                assertFalse(copy.resetRequired || copy.deleted)
                assertEquals(expected.toByteArray(Charsets.UTF_8).size.toULong(), copy.conversion.copiedTextBytes)
                assertNotNull(bounded.recoveryFlushDelay())
                assertEquals(copy.recovery.accepted, bounded.flushRecovery().durable)
                assertNull(bounded.recoveryFlushDelay())
                assertFalse(bounded.resumeRecovery().paused)
                bounded.intoFull().session.use { restored ->
                    try { bounded.cursor(); fail("old bounded alias accepted") }
                    catch (_: EditorBoundedException.Unavailable) {}
                    assertEquals(expected, restored.sourceText())
                    assertArrayEquals(view, restored.displayText().toByteArray(Charsets.UTF_8))
                    store.createNote("oracle", "", expected)
                    store.openEditor("oracle").use { oracle ->
                        val range = EditorByteRange(0uL, view.size.toULong())
                        val revision = restored.revision()
                        assertEquals(oracle.project(0uL, range).copy(revision = revision), restored.project(revision, range))
                        oracle.detach()
                    }
                    repeat(4) { checkNotNull(restored.undo(restored.revision())) }
                    assertEquals(source, restored.sourceText())
                    restored.detach()
                }
            }
        }
    }

    @Test
    fun refusedEntryReturnsTheSameFullCompositionAndUndoOwner() = vault { store, _ ->
        val source = "```\nab\n```\n"
        store.createNote("plain", "", source)
        store.openEditor("plain").use { full ->
            full.replaceUtf16(0uL, EditorUtf16Range(1uL, 1uL), listOf(120u.toUShort()))
            full.composeUtf16(1uL, EditorUtf16Range(2uL, 2uL), listOf(109u.toUShort()))
            try { full.intoBounded(1uL, 87uL, 1uL); fail("composition entry accepted") }
            catch (error: EditorBoundedException.Session) { assertTrue(error.error is EditorSessionException.CompositionActive) }
            assertEquals(0uL, full.lastBoundedOperationWork().work.metadataItems)
            assertEquals("m", full.composition()?.text)
            assertEquals("```\naxb\n```\n", full.sourceText())
            full.cancelComposition(1uL)
            full.intoBounded(1uL, 87uL, 1uL).use { bounded ->
                bounded.intoFull().session.use { restored ->
                    checkNotNull(restored.undo(1uL))
                    assertEquals(source, restored.sourceText())
                    restored.detach()
                }
            }
        }
    }

    @Test
    fun failedMaterializationAndAppendPreserveTheBoundedOwnerAndAcceptedCopy() = vault { store, root ->
        val source = "```\nab\n```\n"
        store.createNote("plain", "", source)
        store.openEditor("plain").use { full ->
            full.intoBounded(0uL, 88uL, 0uL).use { bounded ->
                val prepared = checkNotNull(File(root, ".futo-editor-recovery").listFiles()).single { it.extension == "prepared" }
                val owned = File(prepared.path + ".owned")
                check(prepared.renameTo(owned))
                prepared.writeText("foreign")
                val before = bounded.cursor()
                try { bounded.intoFull(); fail("foreign preparation cleanup accepted") }
                catch (error: EditorBoundedException.Session) { assertTrue(error.error is EditorSessionException.Recovery) }
                assertEquals(before, bounded.cursor())
                assertFalse(bounded.resetRequired())
                // Caller retains the rejected raw callback. Accepted-source copy
                // never previews that unaccepted candidate.
                val rejectedRaw = 120u
                try { bounded.insertLiteral(before, 1uL, rejectedRaw); fail("foreign preparation append accepted") }
                catch (error: EditorBoundedException.Session) { assertTrue(error.error is EditorSessionException.RecoveryAppend) }
                val copy = bounded.acceptedSource()
                assertTrue(bounded.lastOperationWork().work.copiedBytes > 0uL)
                assertEquals(source, copy.source)
                assertEquals(0uL, copy.revision)
                assertTrue(copy.recovery.paused)
                assertEquals(before, bounded.cursor())
                try { bounded.resumeRecovery(); fail("foreign preparation resume accepted") }
                catch (error: EditorBoundedException.Session) { assertTrue(error.error is EditorSessionException.RecoveryResume) }
                assertEquals("foreign", prepared.readText())
                try { store.openEditor("plain"); fail("failed transfer released the lease") }
                catch (_: EditorSessionException.SessionAlreadyOpen) {}
                check(prepared.delete()) // Only this test's foreign fixture.
                check(owned.renameTo(prepared))
                assertFalse(bounded.resumeRecovery().paused)
                bounded.insertLiteral(before, 1uL, rejectedRaw)
                bounded.intoFull().session.use { restored ->
                    assertEquals("```\naxb\n```\n", restored.sourceText())
                    checkNotNull(restored.undo(1uL))
                    assertEquals(source, restored.sourceText())
                    restored.detach()
                }
            }
        }
    }

    @Test
    fun registryResetAndTerminalDeletionPreserveTypedAuthorityAndAcceptedSource() = vault { store, _ ->
        store.createNote("plain", "", "```\nab\n```\n")
        store.openEditor("plain").use { full ->
            full.replaceUtf16(0uL, EditorUtf16Range(0uL, 0uL), listOf(120u.toUShort()))
            full.intoBounded(1uL, 89uL, 0uL).use { bounded ->
                val old = bounded.cursor()
                store.rename("plain", "renamed")
                assertTrue(bounded.resetRequired())
                try { bounded.insertLiteral(old, 0uL, 65u); fail("retired bounded coordinates accepted") }
                catch (_: EditorBoundedException.ModeResetRequired) {}
                val reset = bounded.acceptedSource()
                assertEquals("```\nxab\n```\n", reset.source)
                assertEquals(1uL, reset.revision)
                assertTrue(reset.resetRequired && !reset.deleted)
                bounded.intoFull().session.use { restored ->
                    assertEquals("renamed", restored.noteId())
                    checkNotNull(restored.undo(1uL))
                    restored.intoBounded(2uL, 90uL, 0uL).use { deleted ->
                        store.delete("renamed")
                        store.createNote("renamed", "", "fresh")
                        try { deleted.cursor(); fail("deleted cursor accepted") }
                        catch (error: EditorBoundedException.Session) { assertTrue(error.error is EditorSessionException.SessionDeleted) }
                        try { deleted.intoFull(); fail("deleted transfer accepted") }
                        catch (error: EditorBoundedException.Session) { assertTrue(error.error is EditorSessionException.SessionDeleted) }
                        val copy = deleted.acceptedSource()
                        assertTrue(copy.deleted)
                        assertEquals(2uL, copy.revision)
                        assertEquals("```\nab\n```\n", copy.source)
                        deleted.detach()
                    }
                }
                store.openEditor("renamed").use { fresh ->
                    assertEquals("fresh", fresh.sourceText())
                    fresh.detach()
                }
            }
        }
    }
}
