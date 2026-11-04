package com.futo.notes

import android.Manifest
import android.app.Activity
import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.contract.ActivityResultContract
import androidx.core.app.ActivityOptionsCompat
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.localization.Localization
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Android owns the result registry and SavedState; the camera supplies the result. */
class CameraRecreationTest {
    @Test fun pendingDestinationAndOutputSurviveActivityRecreation() = exercise(success = true, retired = false)

    @Test fun canceledCaptureCleansItsRestoredOutput() = exercise(success = false, retired = false)

    @Test fun lateRetiredResultCannotBecomeAnotherNotesCapture() = exercise(success = true, retired = true)

    private fun exercise(success: Boolean, retired: Boolean) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.CAMERA)
        val app = context.applicationContext as Application
        lateinit var picker: ImagePicker
        lateinit var results: ActivityResultRegistry
        var requestCode = 0
        val callbacks = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityPostCreated(activity: Activity, savedInstanceState: Bundle?) {
                if (activity.javaClass == ComponentActivity::class.java) {
                    results = object : ActivityResultRegistry() {
                        override fun <I, O> onLaunch(code: Int, contract: ActivityResultContract<I, O>, input: I, options: ActivityOptionsCompat?) {
                            requestCode = code
                        }
                    }
                    savedInstanceState?.getBundle("camera-test-results")?.let(results::onRestoreInstanceState)
                    picker = ImagePicker(activity as ComponentActivity, results) {
                        Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
                    }
                }
            }
            override fun onActivityCreated(a: Activity, state: Bundle?) = Unit
            override fun onActivityStarted(a: Activity) = Unit
            override fun onActivityResumed(a: Activity) = Unit
            override fun onActivityPaused(a: Activity) = Unit
            override fun onActivityStopped(a: Activity) = Unit
            override fun onActivitySaveInstanceState(a: Activity, state: Bundle) {
                if (a.javaClass == ComponentActivity::class.java) {
                    val saved = Bundle()
                    results.onSaveInstanceState(saved)
                    state.putBundle("camera-test-results", saved)
                }
            }
            override fun onActivityDestroyed(a: Activity) = Unit
        }
        app.registerActivityLifecycleCallbacks(callbacks)
        try {
            ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
                lateinit var id: String
                lateinit var output: File
                scenario.onActivity { activity ->
                    id = checkNotNull(picker.captureCameraForNote("origin", "/scratch/vault", caretStart = 7, caretEnd = 9))
                    val capture = checkNotNull(picker.pendingCamera)
                    val uri = checkNotNull(capture.uri)
                    activity.contentResolver.openOutputStream(uri)!!.use { it.write(byteArrayOf(1, 2, 3)) }
                    output = File(File(activity.cacheDir, "camera"), uri.lastPathSegment!!)
                    if (retired) {
                        picker.finishCamera(id)
                        // The retired OS request must drain before another launch.
                        assertNull(picker.captureCameraForNote("other", "/scratch/vault"))
                        // A camera can finish writing after the originating screen left.
                        output.writeBytes(byteArrayOf(4, 5, 6))
                    }
                }
                scenario.recreate()
                scenario.moveToState(Lifecycle.State.RESUMED)
                scenario.onActivity { activity ->
                    if (retired) {
                        assertNull(picker.pendingCamera)
                        assertNull(picker.captureCameraForNote("other", "/scratch/vault"))
                        results.dispatchResult(requestCode, success)
                        assertNull(picker.pendingCamera)
                        assertFalse(output.exists())
                        val next = picker.captureCameraForNote("other", "/scratch/vault")
                        assertNotNull(next)
                        assertEquals("other", picker.pendingCamera?.noteId)
                        results.dispatchResult(requestCode, false)
                        picker.finishCamera(next!!)
                        return@onActivity
                    }
                    val restored = checkNotNull(picker.pendingCamera)
                    assertEquals(id, restored.id)
                    assertEquals("origin", restored.noteId)
                    assertEquals("/scratch/vault", restored.vaultRoot)
                    assertTrue(restored.recovered)
                    assertEquals("the caret the photo belongs at survives recreation", 7 to 9, restored.caretStart to restored.caretEnd)
                    results.dispatchResult(requestCode, success)
                    val result = checkNotNull(picker.pendingCamera)
                    assertTrue(result.complete)
                    assertEquals(success, result.success)
                    assertNotNull(result.uri)
                    picker.finishCamera(id)
                    assertFalse(output.exists())
                    assertNull(picker.pendingCamera)
                }
            }
        } finally { app.unregisterActivityLifecycleCallbacks(callbacks) }
    }
}
