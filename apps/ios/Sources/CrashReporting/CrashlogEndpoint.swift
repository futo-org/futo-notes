import Foundation

enum CrashlogEndpoint {
    static let stagingKey = "futo.crashlog.useStaging"

    private static let productionBaseUrl = "https://notes-crashlog.futo.org"
    private static let stagingBaseUrl = "https://staging-notes-crashlog.futo.org"
    #if DEBUG
        private struct DevPorts: Decodable { let crashlogPort: Int }
        private static let localBaseUrl: String = {
            guard let url = Bundle.main.url(forResource: "futo-dev-ports", withExtension: "json"),
                let data = try? Data(contentsOf: url),
                let ports = try? JSONDecoder().decode(DevPorts.self, from: data),
                (1...65535).contains(ports.crashlogPort)
            else {
                preconditionFailure("Missing developer collector port; rebuild this worktree")
            }
            return "http://localhost:\(ports.crashlogPort)"
        }()
    #endif

    static func devBaseUrl(useStaging: Bool) -> String {
        #if DEBUG
            useStaging ? stagingBaseUrl : localBaseUrl
        #else
            productionBaseUrl
        #endif
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
