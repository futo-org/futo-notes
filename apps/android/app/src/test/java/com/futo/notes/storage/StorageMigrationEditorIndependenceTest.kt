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
        val source = productionSource("NotesStore.kt")
        val snapshotDrafts = source.indexOf("val drafts = pendingEditor.currentDrafts()")
        val flushDraft = source.indexOf("core.flushDraft", startIndex = snapshotDrafts)
        val stageMigration = source.indexOf("core.stageVaultMigration", startIndex = flushDraft)

        assertTrue("migrateVault must snapshot retained drafts", snapshotDrafts >= 0)
        assertTrue("migrateVault must flush retained drafts", flushDraft > snapshotDrafts)
        assertTrue("migrateVault must flush drafts before staging the vault", stageMigration > flushDraft)
    }
}
