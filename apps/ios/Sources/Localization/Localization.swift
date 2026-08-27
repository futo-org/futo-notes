import Foundation
import SwiftUI

struct Language: Equatable, Sendable {
    let tag: String
    let nativeName: String
    let direction: String
}

struct LocalizedMessage {
    let path: String
    let arguments: [String: Any]

    init(_ path: String, arguments: [String: Any] = [:]) {
        self.path = path
        self.arguments = arguments
    }
}

private struct LocalizationEnvironmentKey: EnvironmentKey {
    static let defaultValue = Localization.system()
}

extension EnvironmentValues {
    var localization: Localization {
        get { self[LocalizationEnvironmentKey.self] }
        set { self[LocalizationEnvironmentKey.self] = newValue }
    }
}

enum TemplateToken {
    case text(String)
    case placeholder(String)
}

enum CatalogMessage {
    case plain([TemplateToken])
    case plural(argument: String, variants: [String: [TemplateToken]])
}

struct RuntimeCatalog {
    let tag: String
    let englishName: String
    let nativeName: String
    let direction: String
    let aliases: [String]
    let messages: [String: CatalogMessage]
}

private struct LanguageShape {
    let language: String
    let script: String?
    let hasRegion: Bool
}

final class Localization {
    let effectiveLanguage: Language
    let availableLanguages: [Language]

    private let formatLanguageTag: String
    private let messageCatalogs: [RuntimeCatalog]
    private let currentTimeMillis: () -> Double
    private let reportDiagnostic: (String) -> Void
    private var reportedDiagnostics: Set<String> = []

    static func system(
        requestedLanguageTags: [String] = Locale.preferredLanguages,
        regionalLanguageTag: String = Locale.current.identifier,
        regionalNumberingSystem: Locale.NumberingSystem = Locale.current.numberingSystem
    ) -> Localization {
        return Localization(
            runtimeCatalogs: GeneratedLanguageCatalogs.catalogs,
            requestedLanguageTags: requestedLanguageTags,
            regionalLanguageTag: regionalLanguageTag,
            regionalNumberingSystem: regionalNumberingSystem
        )
    }

    convenience init(
        catalogData: [String: Data],
        requestedLanguageTags: [String],
        regionalLanguageTag: String?,
        regionalNumberingSystem: Locale.NumberingSystem? = nil,
        currentTimeMillis: @escaping () -> Double = { Date().timeIntervalSince1970 * 1_000 },
        reportDiagnostic: @escaping (String) -> Void = { NSLog("%@", $0) }
    ) {
        var catalogProblems: Set<String> = []
        let catalogs = catalogData.compactMap { languageTag, data in
            guard let catalog = Self.parseCatalog(
                languageTag: languageTag,
                data: data,
                report: { key, message in
                    if catalogProblems.insert(key).inserted { reportDiagnostic(message) }
                }
            ) else {
                let key = "\(languageTag):catalog:invalid-catalog"
                if catalogProblems.insert(key).inserted {
                    reportDiagnostic(
                        "Localization catalog error: language=\(languageTag) path=catalog type=invalid-catalog"
                    )
                }
                return nil
            }
            return catalog
        }
        self.init(
            runtimeCatalogs: catalogs,
            requestedLanguageTags: requestedLanguageTags,
            regionalLanguageTag: regionalLanguageTag,
            regionalNumberingSystem: regionalNumberingSystem,
            currentTimeMillis: currentTimeMillis,
            reportDiagnostic: reportDiagnostic
        )
    }

    init(
        runtimeCatalogs: [RuntimeCatalog],
        requestedLanguageTags: [String],
        regionalLanguageTag: String?,
        regionalNumberingSystem: Locale.NumberingSystem? = nil,
        currentTimeMillis: @escaping () -> Double = { Date().timeIntervalSince1970 * 1_000 },
        reportDiagnostic: @escaping (String) -> Void = { NSLog("%@", $0) }
    ) {
        let selectedCatalog = Self.selectCatalog(
            requestedLanguageTags: requestedLanguageTags,
            catalogs: runtimeCatalogs
        )
        let effectiveLanguage = selectedCatalog.map {
            Language(tag: $0.tag, nativeName: $0.nativeName, direction: $0.direction)
        } ?? Language(tag: "en", nativeName: "English", direction: "ltr")
        let formatLanguageTag = Self.formattingLanguageTag(
            selectedLanguageTag: effectiveLanguage.tag,
            regionalLanguageTag: regionalLanguageTag,
            regionalNumberingSystem: regionalNumberingSystem
        )
        let availableLanguages = runtimeCatalogs
            .sorted {
                let englishNameOrder = $0.englishName.compare(
                    $1.englishName,
                    options: [],
                    range: nil,
                    locale: Locale(identifier: "en")
                )
                return englishNameOrder == .orderedSame
                    ? $0.tag < $1.tag
                    : englishNameOrder == .orderedAscending
            }
            .map { Language(tag: $0.tag, nativeName: $0.nativeName, direction: $0.direction) }
        self.effectiveLanguage = effectiveLanguage
        self.availableLanguages = availableLanguages
        self.formatLanguageTag = formatLanguageTag
        self.messageCatalogs = Self.fallbackCatalogs(
            selectedCatalog: selectedCatalog,
            catalogs: runtimeCatalogs
        )
        self.currentTimeMillis = currentTimeMillis
        self.reportDiagnostic = reportDiagnostic
    }

    func localizedText(_ path: String, arguments: [String: Any] = [:]) -> String {
        for catalog in messageCatalogs {
            guard let message = catalog.messages[path] else { continue }
            switch message {
            case .plain(let template):
                return renderTemplate(template, arguments: arguments, path: path)
            case .plural(let pluralArgument, let variants):
                guard let pluralValue = integerArgument(arguments[pluralArgument]), pluralValue >= 0 else {
                    reportOnce(
                        key: "\(effectiveLanguage.tag):\(path):invalid-plural-argument",
                        message: "Localization catalog error: language=\(effectiveLanguage.tag) path=\(path) type=invalid-plural-argument"
                    )
                    return path
                }
                let template = variants["=\(pluralValue)"]
                    ?? variants[localizationPluralCategory(languageTag: catalog.tag, value: pluralValue)]
                    ?? variants["other"]
                guard let template else { return path }
                return renderTemplate(template, arguments: arguments, path: path)
            }
        }
        reportOnce(
            key: "\(effectiveLanguage.tag):\(path):missing-message",
            message: "Localization catalog error: language=\(effectiveLanguage.tag) path=\(path) type=missing-message"
        )
        return path
    }

    func localizedFileSize(_ bytes: Int64) -> String {
        if bytes >= 1_000_000_000_000 {
            let value = (Double(bytes) / 1_000_000_000_000 * 10).rounded() / 10
            return localizedText("units.fileSize.terabyte", arguments: ["value": value])
        }
        if bytes >= 1_000_000_000 {
            let value = (Double(bytes) / 1_000_000_000 * 10).rounded() / 10
            return localizedText("units.fileSize.gigabyte", arguments: ["value": value])
        }
        if bytes >= 1_000_000 {
            let value = (Double(bytes) / 1_000_000 * 10).rounded() / 10
            return localizedText("units.fileSize.megabyte", arguments: ["value": value])
        }
        if bytes >= 1_000 {
            let value = (Double(bytes) / 1_000 * 10).rounded() / 10
            return localizedText("units.fileSize.kilobyte", arguments: ["value": value])
        }
        return localizedText("units.fileSize.byte", arguments: ["value": bytes])
    }

    func localizedRelativeTime(_ timestampMillis: Double) -> String {
        let differenceSeconds = (timestampMillis - currentTimeMillis()) / 1_000
        let absoluteSeconds = abs(differenceSeconds)
        if absoluteSeconds < 60 { return localizedText("time.relative.now") }
        if absoluteSeconds >= 365 * 24 * 60 * 60 {
            let count = UInt64(floor(absoluteSeconds / (365 * 24 * 60 * 60)))
            return differenceSeconds < 0
                ? localizedText("time.relative.past.year", arguments: ["count": count])
                : localizedText("time.relative.future.year", arguments: ["count": count])
        }
        if absoluteSeconds >= 30 * 24 * 60 * 60 {
            let count = UInt64(floor(absoluteSeconds / (30 * 24 * 60 * 60)))
            return differenceSeconds < 0
                ? localizedText("time.relative.past.month", arguments: ["count": count])
                : localizedText("time.relative.future.month", arguments: ["count": count])
        }
        if absoluteSeconds >= 24 * 60 * 60 {
            let count = UInt64(floor(absoluteSeconds / (24 * 60 * 60)))
            return differenceSeconds < 0
                ? localizedText("time.relative.past.day", arguments: ["count": count])
                : localizedText("time.relative.future.day", arguments: ["count": count])
        }
        if absoluteSeconds >= 60 * 60 {
            let count = UInt64(floor(absoluteSeconds / (60 * 60)))
            return differenceSeconds < 0
                ? localizedText("time.relative.past.hour", arguments: ["count": count])
                : localizedText("time.relative.future.hour", arguments: ["count": count])
        }
        let count = UInt64(floor(absoluteSeconds / 60))
        return differenceSeconds < 0
            ? localizedText("time.relative.past.minute", arguments: ["count": count])
            : localizedText("time.relative.future.minute", arguments: ["count": count])
    }

    private func renderTemplate(
        _ template: [TemplateToken],
        arguments: [String: Any],
        path: String
    ) -> String {
        let numberFormatter = NumberFormatter()
        numberFormatter.locale = Locale(identifier: formatLanguageTag)
        numberFormatter.maximumFractionDigits = 3
        return template.map { token in
            switch token {
            case .text(let value):
                return value
            case .placeholder(let name):
                guard let value = arguments[name] else {
                    reportOnce(
                        key: "\(effectiveLanguage.tag):\(path):missing-argument:\(name)",
                        message: "Localization catalog error: language=\(effectiveLanguage.tag) path=\(path) type=missing-argument name=\(name)"
                    )
                    return "{\(name)}"
                }
                if let string = value as? String { return string }
                if let number = value as? NSNumber {
                    return numberFormatter.string(from: number) ?? number.stringValue
                }
                return String(describing: value)
            }
        }.joined()
    }

    private func integerArgument(_ value: Any?) -> UInt64? {
        guard let number = value as? NSNumber else { return nil }
        let doubleValue = number.doubleValue
        guard doubleValue.isFinite, doubleValue >= 0, doubleValue.rounded(.towardZero) == doubleValue else {
            return nil
        }
        return UInt64(exactly: doubleValue)
    }

    private func reportOnce(key: String, message: String) {
        if reportedDiagnostics.insert(key).inserted { reportDiagnostic(message) }
    }

    private static func canonicalLanguageTag(_ languageTag: String) -> String? {
        let canonical = Locale.canonicalLanguageIdentifier(from: languageTag)
            .replacingOccurrences(of: "_", with: "-")
        guard !canonical.isEmpty, localizationMaximizeLanguageTag(languageTag: canonical) != nil else {
            return nil
        }
        return canonical
    }

    private static func languageShape(_ languageTag: String, maximize: Bool) -> LanguageShape? {
        let resolvedTag: String
        if maximize {
            guard let maximized = localizationMaximizeLanguageTag(languageTag: languageTag) else {
                return nil
            }
            resolvedTag = maximized
        } else {
            resolvedTag = languageTag
        }
        let components = Locale.Language.Components(identifier: resolvedTag)
        guard let language = components.languageCode?.identifier else { return nil }
        return LanguageShape(
            language: language,
            script: components.script?.identifier,
            hasRegion: components.region != nil
        )
    }

    private static func compatibleCatalogs(
        requestedLanguageTag: String,
        catalogs: [RuntimeCatalog]
    ) -> [RuntimeCatalog] {
        guard let requested = languageShape(requestedLanguageTag, maximize: true),
            let requestedScript = requested.script
        else { return [] }
        return catalogs.filter { catalog in
            guard let candidate = languageShape(catalog.tag, maximize: true) else { return false }
            return candidate.language == requested.language && candidate.script == requestedScript
        }
    }

    private static func selectRequestedCatalog(
        _ requestedLanguageTag: String,
        catalogs: [RuntimeCatalog]
    ) -> RuntimeCatalog? {
        guard let canonicalTag = canonicalLanguageTag(requestedLanguageTag) else { return nil }
        if let exact = catalogs.first(where: { $0.tag == canonicalTag }) { return exact }
        if let alias = catalogs.first(where: { $0.aliases.contains(canonicalTag) }) { return alias }
        let compatible = compatibleCatalogs(requestedLanguageTag: canonicalTag, catalogs: catalogs)
        let generic = compatible.filter {
            languageShape($0.tag, maximize: false)?.hasRegion == false
        }
        if generic.count == 1 { return generic[0] }
        return compatible.count == 1 ? compatible[0] : nil
    }

    private static func selectCatalog(
        requestedLanguageTags: [String],
        catalogs: [RuntimeCatalog]
    ) -> RuntimeCatalog? {
        for requestedLanguageTag in requestedLanguageTags {
            if let catalog = selectRequestedCatalog(requestedLanguageTag, catalogs: catalogs) {
                return catalog
            }
        }
        return catalogs.first(where: { $0.tag == "en" })
    }

    private static func fallbackCatalogs(
        selectedCatalog: RuntimeCatalog?,
        catalogs: [RuntimeCatalog]
    ) -> [RuntimeCatalog] {
        var candidates: [RuntimeCatalog] = []
        if let selectedCatalog {
            candidates.append(selectedCatalog)
            let generic = compatibleCatalogs(
                requestedLanguageTag: selectedCatalog.tag,
                catalogs: catalogs
            ).filter {
                $0.tag != selectedCatalog.tag
                    && languageShape($0.tag, maximize: false)?.hasRegion == false
            }
            if generic.count == 1 { candidates.append(generic[0]) }
        }
        if let english = catalogs.first(where: { $0.tag == "en" }) { candidates.append(english) }
        var seen: Set<String> = []
        return candidates.filter { seen.insert($0.tag).inserted }
    }

    private static func formattingLanguageTag(
        selectedLanguageTag: String,
        regionalLanguageTag: String?,
        regionalNumberingSystem: Locale.NumberingSystem?
    ) -> String {
        var selected = Locale.Components(identifier: selectedLanguageTag)
        let regionalComponents = regionalLanguageTag.map(Locale.Components.init(identifier:))
        selected.region = regionalComponents?.region ?? selected.region
        if let numberingSystem = regionalNumberingSystem
            ?? regionalLanguageTag.map({ Locale(identifier: $0).numberingSystem })
        {
            selected.numberingSystem = numberingSystem
        }
        return Locale(components: selected).identifier
    }

    private static func parseCatalog(
        languageTag: String,
        data: Data,
        report: (String, String) -> Void
    ) -> RuntimeCatalog? {
        guard canonicalLanguageTag(languageTag) == languageTag,
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            root.count == 3,
            root["$schema"] as? String == "./catalog.schema.json",
            let language = root["language"] as? [String: Any],
            language.count == 4,
            let messages = root["messages"] as? [String: Any],
            let englishName = language["englishName"] as? String,
            isValidCatalogText(englishName),
            let nativeName = language["nativeName"] as? String,
            isValidCatalogText(nativeName),
            let direction = language["direction"] as? String,
            direction == "ltr" || direction == "rtl",
            let aliases = language["aliases"] as? [String]
        else { return nil }
        var canonicalAliases: [String] = []
        for alias in aliases {
            guard canonicalLanguageTag(alias) == alias, !canonicalAliases.contains(alias) else {
                return nil
            }
            canonicalAliases.append(alias)
        }
        var flattenedMessages: [String: CatalogMessage] = [:]
        flattenMessages(
            messages,
            languageTag: languageTag,
            segments: [],
            output: &flattenedMessages,
            report: report
        )
        return RuntimeCatalog(
            tag: languageTag,
            englishName: englishName,
            nativeName: nativeName,
            direction: direction,
            aliases: canonicalAliases,
            messages: flattenedMessages
        )
    }

    private static func flattenMessages(
        _ group: [String: Any],
        languageTag: String,
        segments: [String],
        output: inout [String: CatalogMessage],
        report: (String, String) -> Void
    ) {
        for (segment, value) in group {
            let nextSegments = segments + [segment]
            let path = nextSegments.joined(separator: ".")
            guard segment.range(of: "^[a-z][A-Za-z0-9]*$", options: .regularExpression) != nil else {
                report(
                    "\(languageTag):\(path):invalid-path",
                    "Localization catalog error: language=\(languageTag) path=\(path) type=invalid-path"
                )
                continue
            }
            if let message = parseMessage(value) {
                output[path] = message
            } else if let child = value as? [String: Any], child["plural"] == nil,
                child["variants"] == nil
            {
                flattenMessages(
                    child,
                    languageTag: languageTag,
                    segments: nextSegments,
                    output: &output,
                    report: report
                )
            } else {
                report(
                    "\(languageTag):\(path):invalid-message",
                    "Localization catalog error: language=\(languageTag) path=\(path) type=invalid-message"
                )
            }
        }
    }

    private static func parseMessage(_ value: Any) -> CatalogMessage? {
        if let template = value as? String {
            return parseTemplate(template).map(CatalogMessage.plain)
        }
        guard let plural = value as? [String: Any], plural.count == 2,
            let argument = plural["plural"] as? String,
            argument.range(of: "^[a-z][A-Za-z0-9]*$", options: .regularExpression) != nil,
            let rawVariants = plural["variants"] as? [String: Any],
            rawVariants["other"] != nil
        else { return nil }
        let categorySelectors: Set<String> = ["zero", "one", "two", "few", "many", "other"]
        var variants: [String: [TemplateToken]] = [:]
        for (selector, value) in rawVariants {
            let isExact = selector.range(
                of: "^=(?:0|[1-9][0-9]*)$",
                options: .regularExpression
            ) != nil
            guard categorySelectors.contains(selector) || isExact,
                let template = value as? String,
                let tokens = parseTemplate(template)
            else { return nil }
            variants[selector] = tokens
        }
        return .plural(argument: argument, variants: variants)
    }

    private static func isValidCatalogText(_ value: String) -> Bool {
        guard !value.isEmpty,
            value.trimmingCharacters(in: .whitespacesAndNewlines) == value
        else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            switch scalar.value {
            case 0...8, 11...12, 14...31, 0xFFFE...0xFFFF:
                return false
            default:
                return true
            }
        }
    }

    private static func parseTemplate(_ template: String) -> [TemplateToken]? {
        guard isValidCatalogText(template) else { return nil }
        var tokens: [TemplateToken] = []
        var text = ""
        var index = template.startIndex
        func flushText() {
            if !text.isEmpty {
                tokens.append(.text(text))
                text = ""
            }
        }
        while index < template.endIndex {
            let character = template[index]
            let nextIndex = template.index(after: index)
            let nextCharacter = nextIndex < template.endIndex ? template[nextIndex] : nil
            if character == "{", nextCharacter == "{" {
                text.append("{")
                index = template.index(after: nextIndex)
            } else if character == "}", nextCharacter == "}" {
                text.append("}")
                index = template.index(after: nextIndex)
            } else if character == "}" {
                return nil
            } else if character != "{" {
                text.append(character)
                index = nextIndex
            } else {
                guard let closingIndex = template[index...].firstIndex(of: "}") else { return nil }
                let placeholderStart = template.index(after: index)
                let placeholder = String(template[placeholderStart..<closingIndex])
                guard placeholder.range(
                    of: "^[a-z][A-Za-z0-9]*$",
                    options: .regularExpression
                ) != nil else { return nil }
                flushText()
                tokens.append(.placeholder(placeholder))
                index = template.index(after: closingIndex)
            }
        }
        flushText()
        return tokens
    }
}
