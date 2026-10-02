package com.futo.notes.ui.settings.appicon

import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Exercises the installed manifest and real OS boundary, on old and new APIs. */
@RunWith(AndroidJUnit4::class)
class AppIconSystemTest {
    @Test fun allSixChoicesHaveExactlyOneWorkingLauncherAndRetainMainActivity() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val manager = context.packageManager
        val controller = AppIconController(context)
        try {
            for (icon in AppIcon.entries) {
                controller.select(icon)
                assertFalse("OS rejected ${icon.id}", controller.failed)
                assertEquals(icon, controller.selected)
                val active = AppIcon.entries.filter {
                    iconComponentEnabled(manager.getComponentEnabledSetting(
                        ComponentName(context.packageName, it.aliasName)), it.manifestEnabled)
                }
                assertEquals(listOf(icon), active)
                val launchers = manager.queryIntentActivities(
                    Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                        .setPackage(context.packageName), 0,
                )
                assertEquals(listOf(icon.aliasName), launchers.map { it.activityInfo.name })
                val main = manager.getComponentEnabledSetting(
                    ComponentName(context.packageName, "com.futo.notes.MainActivity"))
                assertTrue(main == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT ||
                    main == PackageManager.COMPONENT_ENABLED_STATE_ENABLED)
                val deepLinks = manager.queryIntentActivities(
                    Intent(Intent.ACTION_VIEW, android.net.Uri.parse("futonotes://license/test/test"))
                        .addCategory(Intent.CATEGORY_BROWSABLE).setPackage(context.packageName), 0,
                )
                assertTrue(deepLinks.any { it.activityInfo.name == "com.futo.notes.MainActivity" })
            }
        } finally { controller.reset() }
    }
}
