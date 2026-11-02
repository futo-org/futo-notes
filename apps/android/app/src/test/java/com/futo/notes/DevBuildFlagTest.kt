package com.futo.notes

import com.futo.notes.storage.NotesStorage
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Storage isolation keys off the applicationId, not BuildConfig.DEBUG: the
 * `-PfutoEditorPerf=true` variant is non-debuggable (DEBUG false) but its
 * `.perf.dev` id is still a dev install that must not touch the production vault.
 */
class DevBuildFlagTest {
    @Test
    fun productionIdIsNotDev() {
        assertFalse(NotesStorage.isDevApplicationId("com.futo.notes"))
    }

    @Test
    fun devAndPerfDevIdsAreDev() {
        assertTrue(NotesStorage.isDevApplicationId("com.futo.notes.dev"))
        assertTrue(NotesStorage.isDevApplicationId("com.futo.notes.perf.dev"))
    }
}
