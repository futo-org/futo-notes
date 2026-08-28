package com.futo.notes.localization

import android.icu.text.Collator
import android.icu.text.NumberFormat
import android.icu.text.NumberingSystem
import android.icu.text.PluralRules
import android.icu.util.ULocale
import java.util.Locale

internal object AndroidLocalizationRules {
    fun canonicalLanguageTag(languageTag: String): String? = runCatching {
        Locale.Builder().setLanguageTag(languageTag).build().toLanguageTag()
    }.getOrNull()?.takeUnless { it == "und" }

    fun languageShape(languageTag: String, maximize: Boolean): LanguageShape? = runCatching {
        val locale = ULocale.forLanguageTag(languageTag)
        val resolved = if (maximize) ULocale.addLikelySubtags(locale) else locale
        LanguageShape(
            language = resolved.language,
            script = resolved.script.ifEmpty { null },
            hasRegion = resolved.country.isNotEmpty(),
        )
    }.getOrNull()

    fun formattingLanguageTag(
        selectedLanguageTag: String,
        regionalLanguageTag: String?,
        regionalNumberingSystem: String?,
    ): String = runCatching {
        val selected = ULocale.forLanguageTag(selectedLanguageTag)
        val regional = regionalLanguageTag?.let(ULocale::forLanguageTag)
        ULocale.Builder()
            .setLanguage(selected.language)
            .apply {
                if (selected.script.isNotEmpty()) setScript(selected.script)
                val region = regional?.country?.takeIf { it.isNotEmpty() } ?: selected.country
                if (region.isNotEmpty()) setRegion(region)
                (regionalNumberingSystem ?: regional?.let(NumberingSystem::getInstance)?.name)?.let {
                    setUnicodeLocaleKeyword("nu", it)
                }
            }
            .build()
            .toLanguageTag()
    }.getOrDefault(selectedLanguageTag)

    fun formatNumber(languageTag: String, value: Number): String =
        NumberFormat.getNumberInstance(ULocale.forLanguageTag(languageTag)).apply {
            maximumFractionDigits = 3
        }.format(value)

    fun pluralCategory(languageTag: String, value: Long): String =
        PluralRules.forLocale(ULocale.forLanguageTag(languageTag), PluralRules.PluralType.CARDINAL)
            .select(value.toDouble())

    fun compare(languageTag: String, left: String, right: String): Int =
        Collator.getInstance(ULocale.forLanguageTag(languageTag)).compare(left, right)
}
