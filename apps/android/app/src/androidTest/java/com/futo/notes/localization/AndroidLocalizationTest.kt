package com.futo.notes.localization

import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class AndroidLocalizationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val targetContext = instrumentation.targetContext
    private val cases = instrumentation.context.assets.open("cases.json")
        .bufferedReader()
        .use { JSONObject(it.readText()) }
    private val catalogSources = targetContext.assets.list("languages").orEmpty()
        .filter { it.endsWith(".json") }
        .associate { fileName ->
            fileName.removeSuffix(".json") to targetContext.assets.open("languages/$fileName")
                .bufferedReader()
                .use { it.readText() }
        }

    @Test
    fun sharedLocalizationCasesUseAndroidIcu() {
        val matchingCases = cases.getJSONArray("languageMatching")
        for (index in 0 until matchingCases.length()) {
            val testCase = matchingCases.getJSONObject(index)
            val availableTags = testCase.getJSONArray("availableLanguageTags").strings()
            val sources = availableTags.associateWith { tag ->
                catalogSources[tag] ?: syntheticCatalog(tag)
            }
            val localization = Localization.fromCatalogSources(
                sources,
                AndroidLocalizationRules,
                testCase.getJSONArray("requestedLanguageTags").strings(),
                null,
            )
            assertEquals(testCase.getString("expectedLanguageTag"), localization.effectiveLanguage.tag)
        }

        val messageCases = cases.getJSONArray("messages")
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
        for (index in 0 until fileSizeCases.length()) {
            val testCase = fileSizeCases.getJSONObject(index)
            assertEquals(
                testCase.getString("expected"),
                localization(testCase).localizedFileSize(testCase.getLong("bytes")),
            )
        }

        val now = 1_700_000_000_000L
        val relativeTimeCases = cases.getJSONArray("relativeTimes")
        for (index in 0 until relativeTimeCases.length()) {
            val testCase = relativeTimeCases.getJSONObject(index)
            val timestamp = now + testCase.getLong("secondsFromNow") * 1_000
            assertEquals(
                testCase.getString("expected"),
                localization(testCase, now).localizedRelativeTime(timestamp),
            )
        }
    }

    private fun localization(testCase: JSONObject, now: Long = System.currentTimeMillis()) =
        Localization.fromCatalogSources(
            catalogSources,
            AndroidLocalizationRules,
            listOf(testCase.getString("languageTag")),
            testCase.getString("regionalLanguageTag"),
            testCase.optString("regionalNumberingSystem").takeIf(String::isNotEmpty),
            currentTimeMillis = { now },
        )

    private fun syntheticCatalog(languageTag: String) = JSONObject()
        .put("\$schema", "./catalog.schema.json")
        .put(
            "language",
            JSONObject()
                .put("nativeName", languageTag)
                .put("direction", "ltr")
                .put("aliases", JSONArray()),
        )
        .put("messages", JSONObject())
        .toString()
}

private fun JSONArray.strings(): List<String> =
    (0 until length()).map(::getString)

private fun JSONObject.toMap(): Map<String, Any> =
    keys().asSequence().associateWith { key -> get(key) }
