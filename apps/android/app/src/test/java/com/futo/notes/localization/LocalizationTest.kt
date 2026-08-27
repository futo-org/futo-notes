package com.futo.notes.localization

import java.io.File
import java.text.NumberFormat
import java.util.Locale
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

private object FixtureLocalizationRules : LocalizationRules {
    override fun canonicalLanguageTag(languageTag: String): String? = runCatching {
        Locale.Builder().setLanguageTag(languageTag).build().toLanguageTag()
    }.getOrNull()?.takeUnless { it == "und" }

    override fun languageShape(languageTag: String, maximize: Boolean): LanguageShape? {
        val locale = Locale.forLanguageTag(languageTag)
        if (locale.language.isEmpty()) return null
        val script = if (maximize) {
            when {
                locale.script.isNotEmpty() -> locale.script
                locale.language == "zh" && locale.country == "TW" -> "Hant"
                locale.language == "zh" -> "Hans"
                else -> "Latn"
            }
        } else {
            locale.script.ifEmpty { null }
        }
        return LanguageShape(locale.language, script, locale.country.isNotEmpty())
    }

    override fun formattingLanguageTag(
        selectedLanguageTag: String,
        regionalLanguageTag: String?,
        regionalNumberingSystem: String?,
    ): String {
        val selected = Locale.forLanguageTag(selectedLanguageTag)
        val regional = regionalLanguageTag?.let(Locale::forLanguageTag)
        return Locale.Builder()
            .setLanguage(selected.language)
            .apply {
                if (selected.script.isNotEmpty()) setScript(selected.script)
                val region = regional?.country?.takeIf { it.isNotEmpty() } ?: selected.country
                if (region.isNotEmpty()) setRegion(region)
                regionalNumberingSystem?.let { setUnicodeLocaleKeyword("nu", it) }
            }
            .build()
            .toLanguageTag()
    }

    override fun formatNumber(languageTag: String, value: Number): String =
        NumberFormat.getNumberInstance(Locale.forLanguageTag(languageTag)).apply {
            maximumFractionDigits = 3
        }.format(value)

    override fun pluralCategory(languageTag: String, value: Long): String =
        if (languageTag.startsWith("en") && value == 1L) "one" else "other"

    override fun compare(languageTag: String, left: String, right: String): Int =
        left.compareTo(right)
}

class LocalizationTest {
    private val catalogSources = File("../../../languages")
        .listFiles { file -> file.extension == "json" && file.name != "catalog.schema.json" }
        .orEmpty()
        .associate { file -> file.nameWithoutExtension to file.readText() }
    private val cases = JSONObject(File("../../../tests/localization/cases.json").readText())

    @Test
    fun languageMatchingMatchesSharedCases() {
        val matchingCases = cases.getJSONArray("languageMatching")
        for (index in 0 until matchingCases.length()) {
            val testCase = matchingCases.getJSONObject(index)
            val availableTags = testCase.getJSONArray("availableLanguageTags").strings()
            val sources = availableTags.associateWith { tag ->
                catalogSources[tag] ?: syntheticCatalog(tag, tag)
            }
            val localization = Localization.fromCatalogSources(
                sources,
                FixtureLocalizationRules,
                testCase.getJSONArray("requestedLanguageTags").strings(),
                null,
            )
            assertEquals(testCase.getString("expectedLanguageTag"), localization.effectiveLanguage.tag)
        }
    }

    @Test
    fun availableLanguagesAreOrderedByEnglishName() {
        val localization = Localization.fromCatalogSources(
            mapOf(
                "en" to syntheticCatalog("English", "English"),
                "de" to syntheticCatalog("German", "Deutsch"),
            ),
            FixtureLocalizationRules,
            listOf("en"),
            null,
        )

        assertEquals(listOf("en", "de"), localization.availableLanguages.map { it.tag })
    }

    @Test
    fun invalidCatalogMetadataIsSkipped() {
        val invalidEnglishName = JSONObject(catalogSources.getValue("zh-Hans")).apply {
            getJSONObject("language").put("englishName", "\u0000")
        }
        val invalidNativeName = JSONObject(catalogSources.getValue("zh-Hans")).apply {
            getJSONObject("language").put("nativeName", "\u0000")
        }
        val invalidAlias = JSONObject(catalogSources.getValue("zh-Hans")).apply {
            getJSONObject("language").put("aliases", org.json.JSONArray().put(42))
        }
        for (invalidCatalog in listOf(invalidEnglishName, invalidNativeName, invalidAlias)) {
            val diagnostics = mutableListOf<String>()
            val localization = Localization.fromCatalogSources(
                catalogSources + ("zh-Hans" to invalidCatalog.toString()),
                FixtureLocalizationRules,
                listOf("zh-Hans"),
                "zh-CN",
                reportDiagnostic = diagnostics::add,
            )

            assertEquals("en", localization.effectiveLanguage.tag)
            assertEquals(
                listOf(
                    "Localization catalog error: language=zh-Hans path=catalog type=invalid-catalog",
                ),
                diagnostics,
            )
        }
    }

    @Test
    fun messagesMatchSharedCases() {
        val messageCases = cases.getJSONArray("messages")
        for (index in 0 until messageCases.length()) {
            val testCase = messageCases.getJSONObject(index)
            val localization = localization(testCase)
            val arguments = testCase.optJSONObject("arguments")?.toMap().orEmpty()
            assertEquals(
                testCase.getString("expected"),
                localization.localizedText(testCase.getString("path"), arguments),
            )
        }
    }

    @Test
    fun fileSizesMatchSharedCases() {
        val fileSizeCases = cases.getJSONArray("fileSizes")
        for (index in 0 until fileSizeCases.length()) {
            val testCase = fileSizeCases.getJSONObject(index)
            assertEquals(
                testCase.getString("expected"),
                localization(testCase).localizedFileSize(testCase.getLong("bytes")),
            )
        }
    }

    @Test
    fun relativeTimesMatchSharedCases() {
        val now = 1_700_000_000_000L
        val relativeTimeCases = cases.getJSONArray("relativeTimes")
        for (index in 0 until relativeTimeCases.length()) {
            val testCase = relativeTimeCases.getJSONObject(index)
            val localization = localization(testCase, now)
            val timestamp = now + testCase.getLong("secondsFromNow") * 1_000
            assertEquals(testCase.getString("expected"), localization.localizedRelativeTime(timestamp))
        }
    }

    @Test
    fun invalidMessageLeavesFallBackAndReportOnce() {
        assertInvalidMessageLeafFallsBack(42)
    }

    @Test
    fun controlOnlyMessageLeavesFallBack() {
        assertInvalidMessageLeafFallsBack("\u0000")
    }

    private fun assertInvalidMessageLeafFallsBack(invalidValue: Any) {
        val diagnostics = mutableListOf<String>()
        val sources = catalogSources + (
            "zh-Hans" to JSONObject()
                .put("\$schema", "./catalog.schema.json")
                .put(
                    "language",
                    JSONObject()
                        .put("englishName", "Simplified Chinese")
                        .put("nativeName", "简体中文")
                        .put("direction", "ltr")
                        .put("aliases", org.json.JSONArray()),
                )
                .put(
                    "messages",
                    JSONObject().put(
                        "settings",
                        JSONObject().put(
                            "language",
                            JSONObject().put("heading", invalidValue),
                        ),
                    ),
                )
                .toString()
            )
        val localization = Localization.fromCatalogSources(
            sources,
            FixtureLocalizationRules,
            listOf("zh-Hans"),
            "zh-CN",
            reportDiagnostic = diagnostics::add,
        )

        assertEquals("Language", localization.localizedText("settings.language.heading"))
        assertEquals("Language", localization.localizedText("settings.language.heading"))
        assertEquals(
            listOf(
                "Localization catalog error: language=zh-Hans path=settings.language.heading type=invalid-message",
            ),
            diagnostics,
        )
    }

    @Test
    fun nonStringPluralVariantsFallBack() {
        val diagnostics = mutableListOf<String>()
        val sources = catalogSources + (
            "zh-Hans" to JSONObject()
                .put("\$schema", "./catalog.schema.json")
                .put(
                    "language",
                    JSONObject()
                        .put("englishName", "Simplified Chinese")
                        .put("nativeName", "简体中文")
                        .put("direction", "ltr")
                        .put("aliases", org.json.JSONArray()),
                )
                .put(
                    "messages",
                    JSONObject().put(
                        "time",
                        JSONObject().put(
                            "relative",
                            JSONObject().put(
                                "future",
                                JSONObject().put(
                                    "minute",
                                    JSONObject()
                                        .put("plural", "count")
                                        .put("variants", JSONObject().put("other", 42)),
                                ),
                            ),
                        ),
                    ),
                )
                .toString()
            )
        val localization = Localization.fromCatalogSources(
            sources,
            FixtureLocalizationRules,
            listOf("zh-Hans"),
            "zh-CN",
            reportDiagnostic = diagnostics::add,
        )

        assertEquals(
            "In 2 minutes",
            localization.localizedText("time.relative.future.minute", mapOf("count" to 2)),
        )
        assertEquals(
            listOf(
                "Localization catalog error: language=zh-Hans path=time.relative.future.minute type=invalid-message",
            ),
            diagnostics,
        )
    }

    private fun localization(testCase: JSONObject, now: Long = System.currentTimeMillis()) =
        Localization.fromCatalogSources(
            catalogSources,
            FixtureLocalizationRules,
            listOf(testCase.getString("languageTag")),
            testCase.getString("regionalLanguageTag"),
            testCase.optString("regionalNumberingSystem").takeIf(String::isNotEmpty),
            currentTimeMillis = { now },
        )

    private fun syntheticCatalog(englishName: String, nativeName: String): String = JSONObject()
        .put("\$schema", "./catalog.schema.json")
        .put(
            "language",
            JSONObject()
                .put("englishName", englishName)
                .put("nativeName", nativeName)
                .put("direction", "ltr")
                .put("aliases", org.json.JSONArray()),
        )
        .put("messages", JSONObject())
        .toString()
}

private fun org.json.JSONArray.strings(): List<String> =
    (0 until length()).map(::getString)

private fun JSONObject.toMap(): Map<String, Any> =
    keys().asSequence().associateWith { key -> get(key) }
