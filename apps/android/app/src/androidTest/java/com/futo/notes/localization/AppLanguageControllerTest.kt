package com.futo.notes.localization

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AppLanguageControllerTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val preferences =
        context.getSharedPreferences("app-language-controller-test", Context.MODE_PRIVATE)

    @After
    fun clearPreferences() {
        preferences.edit().clear().commit()
    }

    @Test
    fun storesTheChoiceItselfWhenTheOperatingSystemHasNoPerAppLocale() {
        val controller = AppLanguageController(
            context,
            preferences,
            usesOperatingSystemLocales = false,
        )
        assertNull(controller.selectedLanguageTag)

        controller.select("zh-Hans")
        assertEquals("zh-Hans", controller.selectedLanguageTag)
        assertEquals("zh-Hans", preferences.getString("language", null))

        controller.select("en")
        assertEquals("en", controller.selectedLanguageTag)

        controller.select(null)
        assertNull(controller.selectedLanguageTag)
        assertNull(preferences.getString("language", null))
    }

    @Test
    fun aFreshControllerReadsBackTheStoredChoice() {
        AppLanguageController(context, preferences, usesOperatingSystemLocales = false)
            .select("zh-Hans")

        val reopened = AppLanguageController(
            context,
            preferences,
            usesOperatingSystemLocales = false,
        )
        assertEquals("zh-Hans", reopened.selectedLanguageTag)
    }

    @Test
    fun readsAndWritesTheOperatingSystemPerAppLocaleWhenAvailable() {
        val controller = AppLanguageController(context, preferences, usesOperatingSystemLocales = true)
        controller.select("zh-Hans")
        assertEquals("zh-Hans", controller.selectedLanguageTag)
        assertNull(preferences.getString("language", null))

        controller.select(null)
        assertNull(controller.selectedLanguageTag)
    }
}
