package com.futo.notes.localization

import android.content.res.Resources
import android.icu.text.NumberingSystem
import android.icu.util.ULocale
import org.json.JSONObject

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

internal interface LocalizationRules {
    fun canonicalLanguageTag(languageTag: String): String?
    fun languageShape(languageTag: String, maximize: Boolean): LanguageShape?
    fun formattingLanguageTag(
        selectedLanguageTag: String,
        regionalLanguageTag: String?,
        regionalNumberingSystem: String?,
    ): String
    fun formatNumber(languageTag: String, value: Number): String
    fun pluralCategory(languageTag: String, value: Long): String
    fun compare(languageTag: String, left: String, right: String): Int
}

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
    private val rules: LocalizationRules,
    requestedLanguageTags: List<String>,
    regionalLanguageTag: String?,
    regionalNumberingSystem: String?,
    private val currentTimeMillis: () -> Long,
    private val reportDiagnostic: (String) -> Unit,
) {
    private val reportedDiagnostics = mutableSetOf<String>()
    private val selectedCatalog = selectCatalog(requestedLanguageTags)
    private val formatLanguageTag = rules.formattingLanguageTag(
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
            val englishNameOrder = rules.compare("en", left.englishName, right.englishName)
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
                        ?: message.variants[rules.pluralCategory(catalog.tag, pluralValue)]
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
                        append(rules.formatNumber(formatLanguageTag, value))
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
        val requested = rules.languageShape(requestedLanguageTag, maximize = true)
        if (requested?.script == null) return emptyList()
        return catalogs.filter { catalog ->
            val candidate = rules.languageShape(catalog.tag, maximize = true)
            candidate?.language == requested.language && candidate.script == requested.script
        }
    }

    private fun selectRequestedCatalog(requestedLanguageTag: String): RuntimeCatalog? {
        val canonicalTag = rules.canonicalLanguageTag(requestedLanguageTag) ?: return null
        catalogs.firstOrNull { it.tag == canonicalTag }?.let { return it }
        catalogs.firstOrNull { canonicalTag in it.aliases }?.let { return it }
        val compatible = compatibleCatalogs(canonicalTag)
        val generic = compatible.filter {
            rules.languageShape(it.tag, maximize = false)?.hasRegion == false
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
                it.tag != selected.tag && rules.languageShape(it.tag, maximize = false)?.hasRegion == false
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

        internal fun fromGeneratedCatalogs(
            requestedLanguageTags: List<String>,
            regionalLanguageTag: String?,
            regionalNumberingSystem: String? = null,
            currentTimeMillis: () -> Long = System::currentTimeMillis,
            reportDiagnostic: (String) -> Unit = {},
        ): Localization {
            return Localization(
                GeneratedLanguageCatalogs.catalogs,
                AndroidLocalizationRules,
                requestedLanguageTags,
                regionalLanguageTag,
                regionalNumberingSystem,
                currentTimeMillis,
                reportDiagnostic,
            )
        }

        internal fun fromCatalogSources(
            catalogSources: Map<String, String>,
            rules: LocalizationRules,
            requestedLanguageTags: List<String>,
            regionalLanguageTag: String?,
            regionalNumberingSystem: String? = null,
            currentTimeMillis: () -> Long = System::currentTimeMillis,
            reportDiagnostic: (String) -> Unit = {},
        ): Localization {
            val reportedCatalogProblems = mutableSetOf<String>()
            val catalogs = catalogSources.mapNotNull { (languageTag, source) ->
                parseCatalog(languageTag, source, rules) { key, message ->
                    if (reportedCatalogProblems.add(key)) reportDiagnostic(message)
                } ?: run {
                    val message = "Localization catalog error: language=$languageTag path=catalog type=invalid-catalog"
                    if (reportedCatalogProblems.add("$languageTag:catalog:invalid-catalog")) {
                        reportDiagnostic(message)
                    }
                    null
                }
            }
            return Localization(
                catalogs,
                rules,
                requestedLanguageTags,
                regionalLanguageTag,
                regionalNumberingSystem,
                currentTimeMillis,
                reportDiagnostic,
            )
        }

        private fun parseCatalog(
            languageTag: String,
            source: String,
            rules: LocalizationRules,
            report: (String, String) -> Unit,
        ): RuntimeCatalog? {
            if (rules.canonicalLanguageTag(languageTag) != languageTag) return null
            val root = runCatching { JSONObject(source) }.getOrNull() ?: return null
            if (root.length() != 3 || root.optString("\$schema") != "./catalog.schema.json") {
                return null
            }
            val language = root.optJSONObject("language") ?: return null
            val messages = root.optJSONObject("messages") ?: return null
            if (language.length() != 4) return null
            val englishName = language.opt("englishName") as? String ?: return null
            val nativeName = language.opt("nativeName") as? String ?: return null
            val direction = language.opt("direction") as? String ?: return null
            val aliasesValue = language.optJSONArray("aliases") ?: return null
            if (
                !isValidCatalogText(englishName) ||
                !isValidCatalogText(nativeName) ||
                direction !in setOf("ltr", "rtl")
            ) {
                return null
            }
            val aliases = mutableListOf<String>()
            for (index in 0 until aliasesValue.length()) {
                val alias = aliasesValue.opt(index) as? String ?: return null
                if (rules.canonicalLanguageTag(alias) != alias || alias in aliases) return null
                aliases += alias
            }
            val flattenedMessages = mutableMapOf<String, CatalogMessage>()
            flattenMessages(languageTag, messages, emptyList(), flattenedMessages, report)
            return RuntimeCatalog(
                languageTag,
                englishName,
                nativeName,
                direction,
                aliases,
                flattenedMessages,
            )
        }

        private fun flattenMessages(
            languageTag: String,
            group: JSONObject,
            segments: List<String>,
            messages: MutableMap<String, CatalogMessage>,
            report: (String, String) -> Unit,
        ) {
            for (segment in group.keys()) {
                val nextSegments = segments + segment
                val path = nextSegments.joinToString(".")
                if (!segment.matches(Regex("^[a-z][A-Za-z0-9]*$"))) {
                    report(
                        "$languageTag:$path:invalid-path",
                        "Localization catalog error: language=$languageTag path=$path type=invalid-path",
                    )
                    continue
                }
                val value = group.opt(segment)
                val message = parseMessage(value)
                if (message != null) {
                    messages[path] = message
                } else if (value is JSONObject && !value.has("plural") && !value.has("variants")) {
                    flattenMessages(languageTag, value, nextSegments, messages, report)
                } else {
                    report(
                        "$languageTag:$path:invalid-message",
                        "Localization catalog error: language=$languageTag path=$path type=invalid-message",
                    )
                }
            }
        }

        private fun parseMessage(value: Any?): CatalogMessage? {
            if (value is String) return parseTemplate(value)?.let(CatalogMessage::Plain)
            if (value !is JSONObject || value.length() != 2 || !value.has("plural") || !value.has("variants")) {
                return null
            }
            val pluralArgument = value.optString("plural")
            if (!pluralArgument.matches(Regex("^[a-z][A-Za-z0-9]*$"))) return null
            val variantsValue = value.optJSONObject("variants") ?: return null
            if (!variantsValue.has("other")) return null
            val variants = mutableMapOf<String, List<TemplateToken>>()
            for (selector in variantsValue.keys()) {
                if (
                    selector !in setOf("zero", "one", "two", "few", "many", "other") &&
                    !selector.matches(Regex("^=(?:0|[1-9][0-9]*)$"))
                ) {
                    return null
                }
                val variant = variantsValue.opt(selector)
                if (variant !is String) return null
                val template = parseTemplate(variant) ?: return null
                variants[selector] = template
            }
            return CatalogMessage.Plural(pluralArgument, variants)
        }

        private fun isValidCatalogText(value: String): Boolean {
            if (value.isEmpty() || value.trim() != value) return false
            var index = 0
            while (index < value.length) {
                val character = value[index]
                val codePoint = character.code
                if (
                    codePoint in 0x00..0x08 ||
                    codePoint in 0x0B..0x0C ||
                    codePoint in 0x0E..0x1F ||
                    codePoint in 0xFFFE..0xFFFF
                ) {
                    return false
                }
                if (Character.isHighSurrogate(character)) {
                    if (!Character.isLowSurrogate(value.getOrNull(index + 1) ?: return false)) {
                        return false
                    }
                    index += 2
                } else {
                    if (Character.isLowSurrogate(character)) return false
                    index += 1
                }
            }
            return true
        }

        private fun parseTemplate(template: String?): List<TemplateToken>? {
            if (template == null || !isValidCatalogText(template)) return null
            val tokens = mutableListOf<TemplateToken>()
            var index = 0
            var text = StringBuilder()
            fun flushText() {
                if (text.isNotEmpty()) {
                    tokens += TemplateToken.Text(text.toString())
                    text = StringBuilder()
                }
            }
            while (index < template.length) {
                val character = template[index]
                val nextCharacter = template.getOrNull(index + 1)
                if (character == '{' && nextCharacter == '{') {
                    text.append('{')
                    index += 2
                } else if (character == '}' && nextCharacter == '}') {
                    text.append('}')
                    index += 2
                } else if (character == '}') {
                    return null
                } else if (character != '{') {
                    text.append(character)
                    index += 1
                } else {
                    val closingIndex = template.indexOf('}', index + 1)
                    if (closingIndex == -1) return null
                    val placeholder = template.substring(index + 1, closingIndex)
                    if (!placeholder.matches(Regex("^[a-z][A-Za-z0-9]*$"))) return null
                    flushText()
                    tokens += TemplateToken.Placeholder(placeholder)
                    index = closingIndex + 1
                }
            }
            flushText()
            return tokens
        }
    }
}
