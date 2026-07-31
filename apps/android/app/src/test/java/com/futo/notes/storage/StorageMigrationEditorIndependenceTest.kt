package com.futo.notes.storage

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class StorageMigrationEditorIndependenceTest {
    private fun productionSource(relativePath: String): String {
        val candidates = listOf(
            File("src/main/java/com/futo/notes/$relativePath"),
            File("app/src/main/java/com/futo/notes/$relativePath"),
            File("apps/android/app/src/main/java/com/futo/notes/$relativePath"),
        )
        return candidates.firstOrNull(File::exists)?.readText()
            ?: throw AssertionError(
                "could not locate $relativePath from cwd=${File(".").absolutePath} — tried: " +
                    candidates.joinToString { it.path },
            )
    }

    @Test
    fun `storage migration has no editor snapshot dependency`() {
        val activitySource = productionSource("MainActivity.kt")
        val switchWorkflow = activitySource
            .substringAfter("private fun performSwitch")
            .substringBefore("private fun requestDeviceAccess")
        val editorSource = productionSource("ui/EditorWebView.kt")

        assertFalse(
            "performSwitch must consume committed or retained drafts, never depend on EditorHost",
            switchWorkflow.contains("EditorHost"),
        )
        assertFalse(
            "EditorWebView must not expose a storage-migration capture callback",
            editorSource.contains("freezeAndCaptureContent") ||
                editorSource.contains("onMigrationSnapshot"),
        )
    }

    @Test
    fun `vault migration flushes retained drafts before staging the copy`() {
        val migrateVault = memberBody(productionSource("NotesStore.kt"), "suspend fun migrateVault(")

        val snapshotDrafts = migrateVault.indexOf("pendingEditor.currentDrafts()")
        assertTrue("migrateVault must snapshot retained drafts", snapshotDrafts >= 0)

        // The flush itself is shared with the open-an-existing-folder path, so it
        // is a named helper here rather than the FFI call inline.
        val flushDrafts = migrateVault.indexOf("flushDrafts", snapshotDrafts + 1)
        assertTrue("migrateVault must flush retained drafts", flushDrafts > snapshotDrafts)

        val stageMigration = migrateVault.indexOf("core.stageVaultMigration", flushDrafts)
        assertTrue(
            "migrateVault must flush drafts before staging the vault",
            stageMigration > flushDrafts,
        )
    }

    /**
     * One member's source, so an ordering assertion is about the order of steps
     * inside that function rather than about where other code happens to sit in
     * the file. Searching the whole file made this fail the moment the flush moved
     * into a helper shared with another caller, even though the runtime order was
     * unchanged. Members here are declared at four-space indentation.
     */
    private fun memberBody(source: String, signature: String): String {
        val start = source.indexOf(signature)
        assertTrue("could not find `$signature`", start >= 0)
        val fromSignature = source.substring(start)
        val nextMember = Regex("""\n {4}(/\*\*|(private |internal )?(suspend )?fun |val |var )""")
            .find(fromSignature, startIndex = 1)
        return fromSignature.substring(0, nextMember?.range?.first ?: fromSignature.length)
    }
}
