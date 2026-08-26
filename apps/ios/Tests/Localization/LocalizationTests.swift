import Foundation
import Testing

@testable import FutoNotesNative

private final class LocalizationBundleToken {}

private struct LocalizationCases: Decodable {
    let languageMatching: [LanguageMatchingCase]
    let messages: [MessageCase]
    let fileSizes: [FileSizeCase]
    let relativeTimes: [RelativeTimeCase]
}

private struct LanguageMatchingCase: Decodable {
    let requestedLanguageTags: [String]
    let availableLanguageTags: [String]
    let expectedLanguageTag: String
}

private struct MessageCase: Decodable {
    let languageTag: String
    let regionalLanguageTag: String
    let regionalNumberingSystem: String?
    let path: String
    let arguments: [String: JSONNumber]?
    let expected: String
}

private struct FileSizeCase: Decodable {
    let languageTag: String
    let regionalLanguageTag: String
    let bytes: Int64
    let expected: String
}

private struct RelativeTimeCase: Decodable {
    let languageTag: String
    let regionalLanguageTag: String
    let secondsFromNow: Int64
    let expected: String
}

private enum JSONNumber: Decodable {
    case number(Double)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self = .number(try container.decode(Double.self))
    }

    var value: Double {
        switch self {
        case .number(let value): value
        }
    }
}

private func loadLocalizationCases() throws -> LocalizationCases {
    let bundle = Bundle(for: LocalizationBundleToken.self)
    let url = try #require(
        bundle.url(forResource: "localization-cases", withExtension: "json")
            ?? bundle.url(forResource: "cases", withExtension: "json")
    )
    return try JSONDecoder().decode(LocalizationCases.self, from: Data(contentsOf: url))
}

private func sourceCatalogData() throws -> [String: Data] {
    let url = try #require(
        Bundle.main.url(forResource: "LanguageCatalogs", withExtension: "json")
    )
    let root = try #require(
        JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
    )
    var catalogs: [String: Data] = [:]
    for (languageTag, catalog) in root {
        catalogs[languageTag] = try JSONSerialization.data(withJSONObject: catalog)
    }
    return catalogs
}

private func syntheticCatalogData(languageTag: String, sources: [String: Data]) throws -> Data {
    if let source = sources[languageTag] { return source }
    return try JSONSerialization.data(withJSONObject: [
        "$schema": "./catalog.schema.json",
        "language": ["nativeName": languageTag, "direction": "ltr", "aliases": []],
        "messages": [:],
    ])
}

@Suite("Localization conformance")
struct LocalizationTests {
    @Test("language matching follows shared cases")
    func languageMatching() throws {
        let cases = try loadLocalizationCases()
        let sources = try sourceCatalogData()
        for testCase in cases.languageMatching {
            let available = try Dictionary(
                uniqueKeysWithValues: testCase.availableLanguageTags.map { languageTag in
                    (languageTag, try syntheticCatalogData(languageTag: languageTag, sources: sources))
                }
            )
            let localization = Localization(
                catalogData: available,
                requestedLanguageTags: testCase.requestedLanguageTags,
                regionalLanguageTag: nil,
                reportDiagnostic: { _ in }
            )
            #expect(localization.effectiveLanguage.tag == testCase.expectedLanguageTag)
        }
    }

    @Test("invalid catalog metadata is skipped")
    func invalidCatalogMetadata() throws {
        let invalidLanguages: [[String: Any]] = [
            ["nativeName": "\u{0000}", "direction": "ltr", "aliases": [String]()],
            ["nativeName": "简体中文", "direction": "ltr", "aliases": [42]],
        ]
        for language in invalidLanguages {
            var sources = try sourceCatalogData()
            sources["zh-Hans"] = try JSONSerialization.data(withJSONObject: [
                "$schema": "./catalog.schema.json",
                "language": language,
                "messages": [String: Any](),
            ])
            var diagnostics: [String] = []
            let localization = Localization(
                catalogData: sources,
                requestedLanguageTags: ["zh-Hans"],
                regionalLanguageTag: "zh-CN",
                reportDiagnostic: { diagnostics.append($0) }
            )

            #expect(localization.effectiveLanguage.tag == "en")
            #expect(diagnostics == [
                "Localization catalog error: language=zh-Hans path=catalog type=invalid-catalog"
            ])
        }
    }

    @Test("messages follow shared cases")
    func messages() throws {
        let cases = try loadLocalizationCases()
        let sources = try sourceCatalogData()
        for testCase in cases.messages {
            let localization = Localization(
                catalogData: sources,
                requestedLanguageTags: [testCase.languageTag],
                regionalLanguageTag: testCase.regionalLanguageTag,
                regionalNumberingSystem: testCase.regionalNumberingSystem.map {
                    Locale.NumberingSystem($0)
                },
                reportDiagnostic: { _ in }
            )
            let arguments = testCase.arguments?.mapValues(\.value) ?? [:]
            #expect(localization.localizedText(testCase.path, arguments: arguments) == testCase.expected)
        }
    }

    @Test("file sizes follow shared cases")
    func fileSizes() throws {
        let cases = try loadLocalizationCases()
        let sources = try sourceCatalogData()
        for testCase in cases.fileSizes {
            let localization = Localization(
                catalogData: sources,
                requestedLanguageTags: [testCase.languageTag],
                regionalLanguageTag: testCase.regionalLanguageTag,
                reportDiagnostic: { _ in }
            )
            #expect(localization.localizedFileSize(testCase.bytes) == testCase.expected)
        }
    }

    @Test("relative time follows shared cases")
    func relativeTimes() throws {
        let cases = try loadLocalizationCases()
        let sources = try sourceCatalogData()
        let now = 1_700_000_000_000.0
        for testCase in cases.relativeTimes {
            let localization = Localization(
                catalogData: sources,
                requestedLanguageTags: [testCase.languageTag],
                regionalLanguageTag: testCase.regionalLanguageTag,
                currentTimeMillis: { now },
                reportDiagnostic: { _ in }
            )
            let timestamp = now + Double(testCase.secondsFromNow * 1_000)
            #expect(localization.localizedRelativeTime(timestamp) == testCase.expected)
        }
    }

    @Test("invalid message leaves fall back and report once")
    func invalidMessageLeaf() throws {
        try assertInvalidMessageLeafFallsBack(42)
    }

    @Test("control-only message leaves fall back")
    func controlOnlyMessageLeaf() throws {
        try assertInvalidMessageLeafFallsBack("\u{0000}")
    }

    private func assertInvalidMessageLeafFallsBack(_ invalidValue: Any) throws {
        var sources = try sourceCatalogData()
        sources["zh-Hans"] = try JSONSerialization.data(withJSONObject: [
            "$schema": "./catalog.schema.json",
            "language": ["nativeName": "简体中文", "direction": "ltr", "aliases": []],
            "messages": ["settings": ["language": ["heading": invalidValue]]],
        ])
        var diagnostics: [String] = []
        let localization = Localization(
            catalogData: sources,
            requestedLanguageTags: ["zh-Hans"],
            regionalLanguageTag: "zh-CN",
            reportDiagnostic: { diagnostics.append($0) }
        )

        #expect(localization.localizedText("settings.language.heading") == "Language")
        #expect(localization.localizedText("settings.language.heading") == "Language")
        #expect(diagnostics == [
            "Localization catalog error: language=zh-Hans path=settings.language.heading type=invalid-message"
        ])
    }
}
