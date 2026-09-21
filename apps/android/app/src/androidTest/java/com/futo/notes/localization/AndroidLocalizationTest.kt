package com.futo.notes.localization

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidLocalizationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val cases = instrumentation.context.assets.open("cases.json")
        .bufferedReader()
        .use { JSONObject(it.readText()) }

    @Test
    fun sharedLocalizationCasesUseAndroidIcu() {
        val matchingCases = cases.getJSONArray("languageMatching")
        assertTrue("languageMatching cases are missing", matchingCases.length() > 0)
        for (index in 0 until matchingCases.length()) {
            val testCase = matchingCases.getJSONObject(index)
            val availableTags = testCase.getJSONArray("availableLanguageTags").strings()
            val requestedTags = testCase.getJSONArray("requestedLanguageTags").strings()
            val localization = if (availableTags == listOf("en", "zh-Hans")) {
                Localization.fromGeneratedCatalogs(requestedTags, null)
            } else {
                Localization.fromRuntimeCatalogs(
                    availableTags.map(::emptyCatalog),
                    requestedTags,
                    null,
                )
            }
            assertEquals(testCase.getString("expectedLanguageTag"), localization.effectiveLanguage.tag)
        }

        val messageCases = cases.getJSONArray("messages")
        assertTrue("message cases are missing", messageCases.length() > 0)
        for (index in 0 until messageCases.length()) {
            val testCase = messageCases.getJSONObject(index)
            val localization = localization(testCase)
            assertEquals(
                testCase.getString("expected"),
                localization.localizedText(
                    testCase.getString("path"),
                    testCase.optJSONObject("arguments")?.toMap().orEmpty(),
                ),
            )
        }

        val fileSizeCases = cases.getJSONArray("fileSizes")
        assertTrue("file size cases are missing", fileSizeCases.length() > 0)
        for (index in 0 until fileSizeCases.length()) {
            val testCase = fileSizeCases.getJSONObject(index)
            assertEquals(
                testCase.getString("expected"),
                localization(testCase).localizedFileSize(testCase.getLong("bytes")),
            )
        }

        val now = 1_700_000_000_000L
        val relativeTimeCases = cases.getJSONArray("relativeTimes")
        assertTrue("relative time cases are missing", relativeTimeCases.length() > 0)
        for (index in 0 until relativeTimeCases.length()) {
            val testCase = relativeTimeCases.getJSONObject(index)
            val timestamp = now + testCase.getLong("secondsFromNow") * 1_000
            assertEquals(
                testCase.getString("expected"),
                localization(testCase, now).localizedRelativeTime(timestamp),
            )
        }
    }

    @Test
    fun availableLanguagesAreOrderedByCollatedEnglishName() {
        val localization = Localization.fromRuntimeCatalogs(
            listOf(
                namedCatalog("zu", englishName = "Zulu", nativeName = "isiZulu"),
                namedCatalog("de", englishName = "Ärger", nativeName = "Deutsch"),
            ),
            listOf("zu"),
            null,
        )

        assertEquals(listOf("de", "zu"), localization.availableLanguages.map { it.tag })
    }

    @Test
    fun aRegionalOverrideResolvesToTheCatalogTagTheLanguageRowShows() {
        fun effectiveTagFor(overrideLanguageTag: String) = Localization.fromRuntimeCatalogs(
            catalogs = listOf(
                namedCatalog("en", "English", "English"),
                namedCatalog("zh-Hans", "Simplified Chinese", "\u7b80\u4f53\u4e2d\u6587"),
            ),
            requestedLanguageTags = listOf(overrideLanguageTag),
            regionalLanguageTag = null,
        ).effectiveLanguage.tag

        assertEquals("en", effectiveTagFor("en"))
        assertEquals("en", effectiveTagFor("en-US"))
        assertEquals("en", effectiveTagFor("en-GB"))
        assertEquals("zh-Hans", effectiveTagFor("zh-Hans"))
        assertEquals("zh-Hans", effectiveTagFor("zh-CN"))
    }

    /**
     * The License row's two date formatters (localization.md, docs/spec/license.md
     * § States and copy). They are NOT in `tests/localization/cases.json` — the
     * three platforms' date formatters differ in separators, so a shared golden
     * string would be wrong somewhere — so each adapter locks them with the same
     * two assertions of its own (scripts/drift-registry.json,
     * `localization-shared-catalog`). The web and iOS copies are
     * `src/shared/localization/localization.test.ts` and
     * `apps/ios/Tests/Localization/LocalizationTests.swift`.
     *
     * A year is a date FIELD, not a number: through a number formatter it would
     * come out grouped — "2,026" in English.
     */
    @Test
    fun formatsAYearAsAYearNeverAsAGroupedNumber() {
        // 2026-06-15T12:00:00Z — mid-year, so no timezone can move it.
        val midYear = 1_781_524_800_000L
        val localization = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")

        assertEquals("2026", localization.localizedYear(midYear))
        assertTrue(!localization.localizedYear(midYear).contains(","))
    }

    /** An absolute date names its month rather than numbering it, so it is not
     *  read day-first by one locale and month-first by another. */
    @Test
    fun namesTheMonthInAnAbsoluteDate() {
        // 2029-01-15T12:00:00Z — midday, so no timezone can move the date.
        val formatted = Localization.fromGeneratedCatalogs(listOf("en"), "en-US")
            .localizedAbsoluteDate(1_863_172_800_000L)

        assertTrue(formatted, formatted.contains("2029"))
        assertTrue(formatted, formatted.any(Char::isLetter))
    }

    private fun localization(testCase: JSONObject, now: Long = System.currentTimeMillis()) =
        Localization.fromGeneratedCatalogs(
            listOf(testCase.getString("languageTag")),
            testCase.optString("regionalLanguageTag").takeIf(String::isNotEmpty),
            testCase.optString("regionalNumberingSystem").takeIf(String::isNotEmpty),
            currentTimeMillis = { now },
        )

    private fun emptyCatalog(languageTag: String) =
        namedCatalog(languageTag, englishName = languageTag, nativeName = languageTag)

    private fun namedCatalog(languageTag: String, englishName: String, nativeName: String) =
        RuntimeCatalog(
            tag = languageTag,
            englishName = englishName,
            nativeName = nativeName,
            direction = "ltr",
            aliases = emptyList(),
            messages = emptyMap(),
        )
}

private fun JSONArray.strings(): List<String> =
    (0 until length()).map(::getString)

private fun JSONObject.toMap(): Map<String, Any> =
    keys().asSequence().associateWith { key -> get(key) }
