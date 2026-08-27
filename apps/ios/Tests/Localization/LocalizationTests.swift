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

private func runtimeCatalog(languageTag: String) -> RuntimeCatalog {
    GeneratedLanguageCatalogs.catalogs.first { $0.tag == languageTag }
        ?? RuntimeCatalog(
            tag: languageTag,
            englishName: languageTag,
            nativeName: languageTag,
            direction: "ltr",
            aliases: [],
            messages: [:]
        )
}

private func catalogData(
    englishName: String,
    nativeName: String,
    messages: [String: Any] = [:]
) throws -> Data {
    return try JSONSerialization.data(withJSONObject: [
        "$schema": "./catalog.schema.json",
        "language": [
            "englishName": englishName,
            "nativeName": nativeName,
            "direction": "ltr",
            "aliases": [],
        ],
        "messages": messages,
    ])
}

@Suite("Localization conformance")
struct LocalizationTests {
    @Test("language matching follows shared cases")
    func languageMatching() throws {
        let cases = try loadLocalizationCases()
        for testCase in cases.languageMatching {
            let localization = Localization(
                runtimeCatalogs: testCase.availableLanguageTags.map(runtimeCatalog),
                requestedLanguageTags: testCase.requestedLanguageTags,
                regionalLanguageTag: nil,
                reportDiagnostic: { _ in }
            )
            #expect(localization.effectiveLanguage.tag == testCase.expectedLanguageTag)
        }
    }

    @Test("available languages are ordered by English name")
    func availableLanguageOrdering() {
        let localization = Localization(
            runtimeCatalogs: [
                RuntimeCatalog(
                    tag: "en", englishName: "English", nativeName: "English",
                    direction: "ltr", aliases: [], messages: [:]),
                RuntimeCatalog(
                    tag: "de", englishName: "German", nativeName: "Deutsch",
                    direction: "ltr", aliases: [], messages: [:]),
            ],
            requestedLanguageTags: ["en"],
            regionalLanguageTag: nil,
            reportDiagnostic: { _ in }
        )

        #expect(localization.availableLanguages.map(\.tag) == ["en", "de"])
    }

    @Test("toolbar localization follows the active language")
    @MainActor
    func toolbarLocalizationRefresh() {
        let english = Localization.system(
            requestedLanguageTags: ["en"],
            regionalLanguageTag: "en-US"
        )
        let simplifiedChinese = Localization.system(
            requestedLanguageTags: ["zh-Hans"],
            regionalLanguageTag: "zh-CN"
        )
        let toolbarLocalization = EditorToolbarLocalization(english)

        toolbarLocalization.update(simplifiedChinese)

        #expect(toolbarLocalization.localization === simplifiedChinese)
        #expect(toolbarLocalization.localization.localizedText("editor.toolbar.bold") == "粗体")
    }

    @Test("invalid catalog metadata is skipped")
    func invalidCatalogMetadata() throws {
        let invalidLanguages: [[String: Any]] = [
            [
                "englishName": "\u{0000}",
                "nativeName": "简体中文",
                "direction": "ltr",
                "aliases": [String](),
            ],
            [
                "englishName": "Simplified Chinese",
                "nativeName": "\u{0000}",
                "direction": "ltr",
                "aliases": [String](),
            ],
            [
                "englishName": "Simplified Chinese",
                "nativeName": "简体中文",
                "direction": "ltr",
                "aliases": [42],
            ],
        ]
        for language in invalidLanguages {
            let sources = [
                "en": try catalogData(englishName: "English", nativeName: "English"),
                "zh-Hans": try JSONSerialization.data(withJSONObject: [
                    "$schema": "./catalog.schema.json",
                    "language": language,
                    "messages": [String: Any](),
                ]),
            ]
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
        for testCase in cases.messages {
            let localization = Localization(
                runtimeCatalogs: GeneratedLanguageCatalogs.catalogs,
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
        for testCase in cases.fileSizes {
            let localization = Localization(
                runtimeCatalogs: GeneratedLanguageCatalogs.catalogs,
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
        let now = 1_700_000_000_000.0
        for testCase in cases.relativeTimes {
            let localization = Localization(
                runtimeCatalogs: GeneratedLanguageCatalogs.catalogs,
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
        let sources = [
            "en": try catalogData(
                englishName: "English",
                nativeName: "English",
                messages: ["settings": ["language": ["heading": "Language"]]]
            ),
            "zh-Hans": try JSONSerialization.data(withJSONObject: [
                "$schema": "./catalog.schema.json",
                "language": [
                    "englishName": "Simplified Chinese",
                    "nativeName": "简体中文",
                    "direction": "ltr",
                    "aliases": [],
                ],
                "messages": ["settings": ["language": ["heading": invalidValue]]],
            ]),
        ]
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
