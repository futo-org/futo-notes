package com.futo.notes.localization

import android.app.LocaleManager
import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.LocaleList
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.futo.notes.Prefs

internal class AppLanguageController(
    private val context: Context,
    private val preferences: SharedPreferences,
    private val usesOperatingSystemLocales: Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU,
) {
    var selectedLanguageTag by mutableStateOf(readSelectedLanguageTag())
        private set

    fun select(languageTag: String?) {
        if (usesOperatingSystemLocales) {
            localeManager().applicationLocales =
                if (languageTag == null) LocaleList.getEmptyLocaleList()
                else LocaleList.forLanguageTags(languageTag)
        } else {
            preferences.edit()
                .apply {
                    if (languageTag == null) remove(Prefs.LANGUAGE)
                    else putString(Prefs.LANGUAGE, languageTag)
                }
                .apply()
        }
        selectedLanguageTag = readSelectedLanguageTag()
    }

    fun refresh() {
        selectedLanguageTag = readSelectedLanguageTag()
    }

    private fun localeManager(): LocaleManager =
        context.getSystemService(LocaleManager::class.java)

    private fun readSelectedLanguageTag(): String? =
        if (usesOperatingSystemLocales) {
            localeManager().applicationLocales.takeUnless(LocaleList::isEmpty)?.get(0)?.toLanguageTag()
        } else {
            preferences.getString(Prefs.LANGUAGE, null)
        }
}
