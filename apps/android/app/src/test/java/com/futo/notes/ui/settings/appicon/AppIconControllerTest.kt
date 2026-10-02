package com.futo.notes.ui.settings.appicon

import android.content.pm.PackageManager
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class AppIconControllerTest {
    private class Icons() : AppIconSystem {
        val active = mutableSetOf(AppIcon.LIGHT_STANDARD)
        val calls = mutableListOf<List<Pair<AppIcon, Boolean>>>()
        var failOnce = false
        var onApply: (() -> Unit)? = null
        override fun enabled(icon: AppIcon) = icon in active
        override fun apply(changes: List<Pair<AppIcon, Boolean>>) {
            calls.add(changes)
            onApply?.invoke()
            for ((icon, enabled) in changes) {
                if (enabled) active.add(icon) else active.remove(icon)
                assertTrue("Must retain a launcher entry", active.isNotEmpty())
                if (failOnce) { failOnce = false; error("OS failure after first operation") }
            }
        }
    }
    @Test fun resolvesManifestDefaults() {
        assertTrue(iconComponentEnabled(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, true))
        assertFalse(iconComponentEnabled(PackageManager.COMPONENT_ENABLED_STATE_DEFAULT, false))
        assertTrue(iconComponentEnabled(PackageManager.COMPONENT_ENABLED_STATE_ENABLED, false))
        assertFalse(iconComponentEnabled(PackageManager.COMPONENT_ENABLED_STATE_DISABLED, true))
    }
    @Test fun switchesAndSameChoiceIsNoOp() = runBlocking {
        val icons = Icons()
        val controller = AppIconController(icons)
        controller.select(AppIcon.FUTO)
        assertEquals(setOf(AppIcon.FUTO), icons.active)
        assertEquals(AppIcon.FUTO, controller.selected)
        assertFalse(controller.failed)
        assertEquals(AppIcon.FUTO to true, icons.calls.single().first())
        controller.select(AppIcon.FUTO)
        assertEquals(1, icons.calls.size)
        controller.reset()
        assertEquals(setOf(AppIcon.LIGHT_STANDARD), icons.active)
    }
    @Test fun restoresPriorAfterPartialFailure() = runBlocking {
        val icons = Icons()
        val controller = AppIconController(icons)
        icons.failOnce = true
        controller.select(AppIcon.WEBSITE)
        assertEquals(setOf(AppIcon.LIGHT_STANDARD), icons.active)
        assertEquals(AppIcon.LIGHT_STANDARD, controller.selected)
        assertTrue(controller.failed)
        assertFalse(controller.changing)
    }
    @Test fun ignoresOverlappingRequest() = runBlocking {
        val icons = Icons()
        val controller = AppIconController(icons)
        icons.onApply = {
            assertTrue(controller.changing)
            runBlocking { controller.select(AppIcon.WEBSITE) }
        }
        controller.select(AppIcon.FUTO)
        assertEquals(1, icons.calls.size)
        assertEquals(AppIcon.FUTO, controller.selected)
    }
    @Test fun recoversInterruptedSwitchAndPreservesValidAlternate() = runBlocking {
        val icons = Icons()
        icons.active.add(AppIcon.DARK_STANDARD)
        val controller = AppIconController(icons)
        controller.refresh()
        assertEquals(setOf(AppIcon.DARK_STANDARD), icons.active)
        assertEquals(AppIcon.DARK_STANDARD, controller.selected)
        controller.refresh()
        assertEquals(1, icons.calls.size)
    }
}
