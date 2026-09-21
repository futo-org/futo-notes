import Foundation

enum CrashlogEndpoint {
    static let stagingKey = "futo.crashlog.useStaging"

    private static let productionBaseUrl = "https://notes-crashlog.futo.org"
    private static let stagingBaseUrl = "https://staging-notes-crashlog.futo.org"
    private static let localBaseUrl = "http://localhost:5100"

    static func devBaseUrl(useStaging: Bool) -> String {
        useStaging ? stagingBaseUrl : localBaseUrl
    }

    static var baseUrl: String {
        #if DEBUG
            devBaseUrl(useStaging: UserDefaults.standard.bool(forKey: stagingKey))
        #else
            productionBaseUrl
        #endif
    }

    static func url(_ path: String) -> URL {
        URL(string: baseUrl + path)!
    }
}
