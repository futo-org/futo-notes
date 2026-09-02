import Foundation
import Testing
import UIKit

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
    let regionalLanguageTag: String?
    let regionalNumberingSystem: String?
    let path: String
    let arguments: [String: JSONNumber]?
    let expected: String
}

private struct FileSizeCase: Decodable {
    let languageTag: String
    let regionalLanguageTag: String?
    let bytes: Int64
    let expected: String
}

private struct RelativeTimeCase: Decodable {
    let languageTag: String
    let regionalLanguageTag: String?
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
    let url = try #require(bundle.url(forResource: "cases", withExtension: "json"))
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

@Suite("Localization conformance")
struct LocalizationTests {
    @Test("the Language row opens this app's own iOS Settings page")
    func languageRowOpensAppSettings() {
        #expect(SettingsView.systemSettingsURL.scheme == "app-settings")
        #expect(
            SettingsView.systemSettingsURL.absoluteString
                == UIApplication.openSettingsURLString
        )
    }

    @Test("language matching follows shared cases")
    func languageMatching() throws {
        let cases = try loadLocalizationCases()
        #expect(!cases.languageMatching.isEmpty)
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

    @Test("the Settings language row resolves in every shipped language")
    func settingsLanguageRow() {
        let english = Localization.system(
            requestedLanguageTags: ["en"],
            regionalLanguageTag: "en-US"
        )
        let simplifiedChinese = Localization.system(
            requestedLanguageTags: ["zh-Hans"],
            regionalLanguageTag: "zh-CN"
        )

        #expect(english.localizedText("settings.language.heading") == "Language")
        #expect(
            english.localizedText("settings.language.ios.openSystemSettings")
                == "Open iOS Settings"
        )
        #expect(english.effectiveLanguage.nativeName == "English")

        #expect(simplifiedChinese.localizedText("settings.language.heading") == "语言")
        #expect(
            simplifiedChinese.localizedText("settings.language.ios.openSystemSettings")
                == "打开 iOS 设置"
        )
        #expect(simplifiedChinese.effectiveLanguage.nativeName == "简体中文")
    }

    @Test("messages follow shared cases")
    func messages() throws {
        let cases = try loadLocalizationCases()
        #expect(!cases.messages.isEmpty)
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
            #expect(
                localization.localizedText(testCase.path, arguments: arguments)
                    == testCase.expected
            )
        }
    }

    // iOS reads the app bundle's localized resource directories to decide which
    // languages its per-app Language page may offer. The catalogs are generated
    // into <tag>.lproj/InfoPlist.strings, so a break in that generation would
    // silently leave the page with English only. (Whether iOS shows the row at
    // all is the operating system's call — it requires more than one preferred
    // language on the device; see docs/spec/localization.md.)
    @Test("the app bundle advertises every generated catalog language to iOS")
    func bundleAdvertisesEveryCatalogLanguage() throws {
        let advertised = Set(Bundle.main.localizations)
        #expect(advertised.contains("en"))
        for catalog in GeneratedLanguageCatalogs.catalogs {
            for tag in [catalog.tag] + catalog.aliases {
                #expect(
                    advertised.contains(tag),
                    "bundle does not advertise \(tag); localized resources are missing"
                )
            }
        }
    }

    @Test("file sizes follow shared cases")
    func fileSizes() throws {
        let cases = try loadLocalizationCases()
        #expect(!cases.fileSizes.isEmpty)
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
        #expect(!cases.relativeTimes.isEmpty)
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
}
