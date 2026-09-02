package com.futo.notes.localization

import android.content.res.Resources
import android.icu.text.NumberingSystem
import android.icu.util.ULocale

data class Language(
    val tag: String,
    val nativeName: String,
    val direction: String,
)

internal data class LanguageShape(
    val language: String,
    val script: String?,
    val hasRegion: Boolean,
)

internal sealed interface TemplateToken {
    data class Text(val value: String) : TemplateToken
    data class Placeholder(val name: String) : TemplateToken
}

internal sealed interface CatalogMessage {
    data class Plain(val template: List<TemplateToken>) : CatalogMessage
    data class Plural(
        val pluralArgument: String,
        val variants: Map<String, List<TemplateToken>>,
    ) : CatalogMessage
}

internal data class RuntimeCatalog(
    val tag: String,
    val englishName: String,
    val nativeName: String,
    val direction: String,
    val aliases: List<String>,
    val messages: Map<String, CatalogMessage>,
)

class Localization private constructor(
    private val catalogs: List<RuntimeCatalog>,
    requestedLanguageTags: List<String>,
    regionalLanguageTag: String?,
    regionalNumberingSystem: String?,
    private val currentTimeMillis: () -> Long,
    private val reportDiagnostic: (String) -> Unit,
) {
    private val reportedDiagnostics = mutableSetOf<String>()
    private val selectedCatalog = selectCatalog(requestedLanguageTags)
    private val formatLanguageTag = AndroidLocalizationRules.formattingLanguageTag(
        selectedCatalog?.tag ?: "en",
        regionalLanguageTag,
        regionalNumberingSystem,
    )
    private val messageCatalogs = fallbackCatalogs()

    val effectiveLanguage = selectedCatalog?.let {
        Language(it.tag, it.nativeName, it.direction)
    } ?: Language("en", "English", "ltr")

    val availableLanguages = catalogs
        .sortedWith { left, right ->
            val englishNameOrder = AndroidLocalizationRules.compare("en", left.englishName, right.englishName)
            englishNameOrder.takeIf { it != 0 } ?: left.tag.compareTo(right.tag)
        }
        .map { Language(it.tag, it.nativeName, it.direction) }

    fun localizedText(path: String, arguments: Map<String, Any> = emptyMap()): String {
        for (catalog in messageCatalogs) {
            when (val message = catalog.messages[path]) {
                is CatalogMessage.Plain -> {
                    return renderTemplate(message.template, arguments, path)
                }
                is CatalogMessage.Plural -> {
                    val pluralValue = integerArgument(arguments[message.pluralArgument])
                    if (pluralValue == null || pluralValue < 0) {
                        reportOnce(
                            "${effectiveLanguage.tag}:$path:invalid-plural-argument",
                            "Localization catalog error: language=${effectiveLanguage.tag} path=$path type=invalid-plural-argument",
                        )
                        return path
                    }
                    val exactSelector = "=$pluralValue"
                    val template = message.variants[exactSelector]
                        ?: message.variants[AndroidLocalizationRules.pluralCategory(catalog.tag, pluralValue)]
                        ?: message.variants.getValue("other")
                    return renderTemplate(template, arguments, path)
                }
                null -> continue
            }
        }
        reportOnce(
            "${effectiveLanguage.tag}:$path:missing-message",
            "Localization catalog error: language=${effectiveLanguage.tag} path=$path type=missing-message",
        )
        return path
    }

    fun localizedFileSize(bytes: Long): String {
        if (bytes >= 1_000_000_000_000L) {
            val value = kotlin.math.floor(bytes.toDouble() / 1_000_000_000_000L * 10.0 + 0.5) / 10.0
            return localizedText("units.fileSize.terabyte", mapOf("value" to value))
        }
        if (bytes >= 1_000_000_000L) {
            val value = kotlin.math.floor(bytes.toDouble() / 1_000_000_000L * 10.0 + 0.5) / 10.0
            return localizedText("units.fileSize.gigabyte", mapOf("value" to value))
        }
        if (bytes >= 1_000_000L) {
            val value = kotlin.math.floor(bytes.toDouble() / 1_000_000L * 10.0 + 0.5) / 10.0
            return localizedText("units.fileSize.megabyte", mapOf("value" to value))
        }
        if (bytes >= 1_000L) {
            val value = kotlin.math.floor(bytes.toDouble() / 1_000L * 10.0 + 0.5) / 10.0
            return localizedText("units.fileSize.kilobyte", mapOf("value" to value))
        }
        return localizedText("units.fileSize.byte", mapOf("value" to bytes))
    }

    fun localizedRelativeTime(timestampMillis: Long): String {
        val differenceSeconds = (timestampMillis - currentTimeMillis()) / 1_000.0
        val absoluteSeconds = kotlin.math.abs(differenceSeconds)
        if (absoluteSeconds < 60) return localizedText("time.relative.now")
        if (absoluteSeconds >= 365L * 24 * 60 * 60) {
            val count = kotlin.math.floor(absoluteSeconds / (365L * 24 * 60 * 60)).toLong()
            return if (differenceSeconds < 0) {
                localizedText("time.relative.past.year", mapOf("count" to count))
            } else {
                localizedText("time.relative.future.year", mapOf("count" to count))
            }
        }
        if (absoluteSeconds >= 30L * 24 * 60 * 60) {
            val count = kotlin.math.floor(absoluteSeconds / (30L * 24 * 60 * 60)).toLong()
            return if (differenceSeconds < 0) {
                localizedText("time.relative.past.month", mapOf("count" to count))
            } else {
                localizedText("time.relative.future.month", mapOf("count" to count))
            }
        }
        if (absoluteSeconds >= 24L * 60 * 60) {
            val count = kotlin.math.floor(absoluteSeconds / (24L * 60 * 60)).toLong()
            return if (differenceSeconds < 0) {
                localizedText("time.relative.past.day", mapOf("count" to count))
            } else {
                localizedText("time.relative.future.day", mapOf("count" to count))
            }
        }
        if (absoluteSeconds >= 60L * 60) {
            val count = kotlin.math.floor(absoluteSeconds / (60L * 60)).toLong()
            return if (differenceSeconds < 0) {
                localizedText("time.relative.past.hour", mapOf("count" to count))
            } else {
                localizedText("time.relative.future.hour", mapOf("count" to count))
            }
        }
        val count = kotlin.math.floor(absoluteSeconds / 60L).toLong()
        return if (differenceSeconds < 0) {
            localizedText("time.relative.past.minute", mapOf("count" to count))
        } else {
            localizedText("time.relative.future.minute", mapOf("count" to count))
        }
    }

    private fun renderTemplate(
        template: List<TemplateToken>,
        arguments: Map<String, Any>,
        path: String,
    ): String = buildString {
        for (token in template) {
            when (token) {
                is TemplateToken.Text -> append(token.value)
                is TemplateToken.Placeholder -> {
                    val value = arguments[token.name]
                    if (value == null) {
                        reportOnce(
                            "${effectiveLanguage.tag}:$path:missing-argument:${token.name}",
                            "Localization catalog error: language=${effectiveLanguage.tag} path=$path type=missing-argument name=${token.name}",
                        )
                        append("{${token.name}}")
                    } else if (value is Number) {
                        append(AndroidLocalizationRules.formatNumber(formatLanguageTag, value))
                    } else {
                        append(value.toString())
                    }
                }
            }
        }
    }

    private fun integerArgument(value: Any?): Long? {
        if (value !is Number) return null
        val doubleValue = value.toDouble()
        if (!doubleValue.isFinite() || doubleValue % 1.0 != 0.0) return null
        return doubleValue.toLong()
    }

    private fun reportOnce(key: String, message: String) {
        if (reportedDiagnostics.add(key)) reportDiagnostic(message)
    }

    private fun compatibleCatalogs(requestedLanguageTag: String): List<RuntimeCatalog> {
        val requested = AndroidLocalizationRules.languageShape(requestedLanguageTag, maximize = true)
        if (requested?.script == null) return emptyList()
        return catalogs.filter { catalog ->
            val candidate = AndroidLocalizationRules.languageShape(catalog.tag, maximize = true)
            candidate?.language == requested.language && candidate.script == requested.script
        }
    }

    private fun selectRequestedCatalog(requestedLanguageTag: String): RuntimeCatalog? {
        val canonicalTag = AndroidLocalizationRules.canonicalLanguageTag(requestedLanguageTag) ?: return null
        catalogs.firstOrNull { it.tag == canonicalTag }?.let { return it }
        catalogs.firstOrNull { canonicalTag in it.aliases }?.let { return it }
        val compatible = compatibleCatalogs(canonicalTag)
        val generic = compatible.filter {
            AndroidLocalizationRules.languageShape(it.tag, maximize = false)?.hasRegion == false
        }
        if (generic.size == 1) return generic.first()
        return compatible.singleOrNull()
    }

    private fun selectCatalog(requestedLanguageTags: List<String>): RuntimeCatalog? {
        for (requestedLanguageTag in requestedLanguageTags) {
            selectRequestedCatalog(requestedLanguageTag)?.let { return it }
        }
        return catalogs.firstOrNull { it.tag == "en" }
    }

    private fun fallbackCatalogs(): List<RuntimeCatalog> {
        val candidates = mutableListOf<RuntimeCatalog>()
        selectedCatalog?.let(candidates::add)
        selectedCatalog?.let { selected ->
            val generic = compatibleCatalogs(selected.tag).filter {
                it.tag != selected.tag && AndroidLocalizationRules.languageShape(it.tag, maximize = false)?.hasRegion == false
            }
            generic.singleOrNull()?.let(candidates::add)
        }
        catalogs.firstOrNull { it.tag == "en" }?.let(candidates::add)
        return candidates.distinctBy { it.tag }
    }

    companion object {
        fun system(
            requestedLanguageTags: List<String>,
            regionalLanguageTag: String = Resources.getSystem().configuration.locales[0]
                .toLanguageTag(),
            regionalNumberingSystem: String = NumberingSystem.getInstance(
                ULocale.forLanguageTag(regionalLanguageTag),
            ).name,
            reportDiagnostic: (String) -> Unit = { message ->
                android.util.Log.e("FutoNotesLocalization", message)
            },
        ): Localization = fromGeneratedCatalogs(
            requestedLanguageTags,
            regionalLanguageTag,
            regionalNumberingSystem,
            reportDiagnostic = reportDiagnostic,
        )

        internal fun fromRuntimeCatalogs(
            catalogs: List<RuntimeCatalog>,
            requestedLanguageTags: List<String>,
            regionalLanguageTag: String?,
            regionalNumberingSystem: String? = null,
            currentTimeMillis: () -> Long = System::currentTimeMillis,
            reportDiagnostic: (String) -> Unit = {},
        ): Localization = Localization(
            catalogs,
            requestedLanguageTags,
            regionalLanguageTag,
            regionalNumberingSystem,
            currentTimeMillis,
            reportDiagnostic,
        )

        internal fun fromGeneratedCatalogs(
            requestedLanguageTags: List<String>,
            regionalLanguageTag: String?,
            regionalNumberingSystem: String? = null,
            currentTimeMillis: () -> Long = System::currentTimeMillis,
            reportDiagnostic: (String) -> Unit = {},
        ): Localization {
            return Localization(
                GeneratedLanguageCatalogs.catalogs,
                requestedLanguageTags,
                regionalLanguageTag,
                regionalNumberingSystem,
                currentTimeMillis,
                reportDiagnostic,
            )
        }
    }
}
