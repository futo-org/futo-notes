#if DEBUG
    import Foundation

    enum PuppetRoute: Equatable {
        case actions
        case tree
        case verb(String)
        case query(String)
    }

    enum PuppetPort: Equatable {
        case absent
        case invalid(String)
        case port(UInt16)
    }

    /// An HTTP reply: its status and JSON body.
    typealias PuppetReply = (status: Int, body: Data)

    extension Route {
        /// The note this route's editor shows; nil for a folder.
        var editorNote: String? {
            switch self {
            case .note(let id), .newNote(let id): id
            case .folder: nil
            }
        }
    }

    enum PuppetServerContract {
        static let portEnvironmentKey = "FUTO_PUPPET_PORT"
        static let maximumRequestBytes = 256 * 1024
        static let queries = [
            "elements", "state", "notes", "search", "file", "observe", "clipboard", "doc", "at",
            "show", "events", "diff", "trace", "touches",
        ]
        /// Queries the WEBVIEW answers about the page it is showing. The webview is one
        /// long-lived instance, so it still holds the last note's document after a GoBack:
        /// forwarding one of these from the native list would answer about a screen the
        /// user is not on. They are refused there instead. `clipboard` is deliberately not
        /// here — it is the agent's own buffer, not the page's, and survives navigation.
        static let pageQueries: Set<String> = [
            "elements", "doc", "at", "show", "events", "diff", "trace",
        ]

        /// Every setting the app stores, under its own key: the `futo.*` UserDefaults keys and the
        /// app's language list (`AppleLanguages`, which the per-app language in iOS Settings
        /// writes). Nothing is picked, so a setting nobody thought to report still shows in a
        /// receipt. Values become JSON: a date as ms since 1970, data as whether it is set. The
        /// license key is masked as the License card masks it; its activation reads "set".
        static func storedSettings(_ defaults: [String: Any]) -> [String: Any] {
            func json(_ value: Any) -> Any {
                switch value {
                case let date as Date: return Int(date.timeIntervalSince1970 * 1000)
                case let data as Data: return data.isEmpty ? NSNull() : "set"
                case let list as [Any]: return list.map(json)
                case let object as [String: Any]: return object.mapValues(json)
                default: return value
                }
            }
            var settings = defaults.filter {
                $0.key.hasPrefix("futo.") || $0.key == "AppleLanguages"
            }.mapValues(json)
            if let key = settings[LicenseStorage.keyDefaultsKey] as? String {
                settings[LicenseStorage.keyDefaultsKey] = maskedLicenseKey(key)
            }
            if settings[LicenseStorage.activationDefaultsKey] != nil {
                settings[LicenseStorage.activationDefaultsKey] = "set"
            }
            return settings
        }

        /// The vault itself, not the rows: every note id and every folder the store knows,
        /// including the folders no note is left in. The same shape the desktop shell's
        /// `vault()` provider answers with, so one driver reads both. `modified` (ms since 1970
        /// per note id) is what `futo-puppet` diffs a receipt's vault by, asked for with
        /// `notes {"modified":true}`.
        static func vault(
            noteIds: [String], folders: [String], modified: [String: Int]? = nil
        ) -> [String: Any] {
            var vault: [String: Any] = ["notes": noteIds.sorted(), "folders": folders.sorted()]
            if let modified { vault["modified"] = modified }
            return vault
        }
        /// `search {"query", "limit"?}`: the query as sent (a trailing space tells the engine the
        /// last word is finished) and how many hits, 10 unless given; nil for a blank query or a
        /// limit that is not a positive whole number.
        static func searchRequest(from body: Data) -> (query: String, limit: UInt32)? {
            let arguments = decodeArguments(from: body)
            guard let query = arguments["query"] as? String,
                !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            guard let raw = arguments["limit"] else { return (query, 10) }
            guard let limit = raw as? Int, limit > 0 else { return nil }
            return (query, UInt32(clamping: limit))
        }
        static let simulatorEnvironmentKey = "SIMULATOR_UDID"

        static func resolvePort(
            environment: [String: String] = ProcessInfo.processInfo.environment
        ) -> PuppetPort {
            guard
                let raw = environment[portEnvironmentKey]?.trimmingCharacters(
                    in: .whitespacesAndNewlines
                ),
                !raw.isEmpty
            else {
                return .absent
            }
            guard let parsed = UInt16(raw), parsed > 0 else {
                return .invalid(raw)
            }
            return .port(parsed)
        }

        static func route(method: String, path: String) -> PuppetRoute? {
            switch method.uppercased() {
            case "GET" where path == "/actions":
                return .actions
            case "GET" where path == "/tree":
                return .tree
            case "POST" where path.hasPrefix("/do/") && path.count > 4:
                return .verb(String(path.dropFirst(4)))
            case "POST" where queries.contains(String(path.dropFirst())):
                return .query(String(path.dropFirst()))
            default:
                return nil
            }
        }

        static func decodeArguments(from body: Data) -> [String: Any] {
            (try? JSONSerialization.jsonObject(with: body) as? [String: Any]) ?? [:]
        }

        /// A non-empty string argument, trimmed; nil for anything else.
        static func text(_ key: String, in arguments: [String: Any]) -> String? {
            guard let value = arguments[key] as? String else { return nil }
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }

        /// Whether a required argument is the kind its schema declares: an integer is a number
        /// that is not a JSON boolean, a boolean is a JSON boolean, anything else a non-empty
        /// string. Android's `screenVerb` checks the same three.
        static func hasKind(
            _ key: String, in arguments: [String: Any], integer: Bool, boolean: Bool
        ) -> Bool {
            let number = arguments[key] as? NSNumber
            let isBoolean = number.map { CFGetTypeID($0) == CFBooleanGetTypeID() } ?? false
            if integer { return number != nil && !isBoolean }
            if boolean { return isBoolean }
            return text(key, in: arguments) != nil
        }

        static func schema(
            _ required: [String], optional: [String] = [], integers: [String] = [],
            booleans: [String] = []
        ) -> [String: Any] {
            var properties: [String: Any] = [:]
            for name in required + optional {
                let type =
                    integers.contains(name)
                    ? "integer" : booleans.contains(name) ? "boolean" : "string"
                properties[name] = ["type": type]
            }
            // A verb behind a confirmation takes `answer`: the CLI presses the dialog's own button next.
            if properties["answer"] != nil {
                properties["answer"] = ["type": "string", "enum": ["confirm", "dismiss"]]
            }
            return ["type": "object", "properties": properties, "required": required]
        }

        /// What `/tree` adds to the screen for aiming: the editor webview's rect when it is on
        /// screen (else null) and the simulator the app runs in, which is everything `axe`
        /// needs to land a touch on a CSS pixel (1 CSS px = 1 point in WKWebView).
        static func aim(
            webview: CGRect?, environment: [String: String] = ProcessInfo.processInfo.environment
        ) -> [String: Any] {
            func rounded(_ value: CGFloat) -> Int { Int(value.rounded()) }
            let box: Any =
                webview.map { rect in
                    [
                        "x": rounded(rect.minX), "y": rounded(rect.minY),
                        "w": rounded(rect.width), "h": rounded(rect.height),
                    ]
                } ?? NSNull()
            return ["webview": box, "udid": environment[simulatorEnvironmentKey] ?? NSNull()]
        }

        /// `openNote` is the id the editor is actually showing, which a rename in place
        /// moves while the pushed route keeps the old one.
        static func screen(
            path: [Route], sheet: PresentedSheet? = nil, searchQuery: String = "",
            openNote: String? = nil
        ) -> String {
            switch sheet {
            case .settings: return "settings"
            case .sync, .settingsSync: return "sync"
            case .settingsFeedback: return "feedback"
            case .none: break
            }
            // Search results replace the root browser; a pushed screen hides the field.
            if path.isEmpty, !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return "search"
            }
            switch path.last {
            case .none: return "list"
            case .folder(let folder): return "folder:\(folder)"
            case .note(let id), .newNote(let id): return "editor:\(openNote ?? id)"
            }
        }

        /// The JS the host evaluates to forward one command; `null` when no inspector is installed.
        static func forwardScript(command: String, argsJson: String) -> String {
            "window.__futoPuppet ? window.__futoPuppet.run(\(jsLiteral(command)), \(jsLiteral(argsJson))) : null"
        }

        /// A value JSON cannot hold (a Swift struct) raises an Objective-C exception that
        /// `try?` cannot catch, which aborts the app: it is refused instead.
        static func json(_ object: Any) -> Data {
            guard JSONSerialization.isValidJSONObject(object) else {
                return Data(
                    #"{"ok":false,"error":"the listener built a reply that is not JSON"}"#.utf8)
            }
            return (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]))
                ?? Data(#"{"ok":false}"#.utf8)
        }

        static func refusal(_ status: Int, _ error: String) -> PuppetReply {
            (status, json(["ok": false, "error": error]))
        }

        /// Split the webview's `{"status":…,"body":…}` reply into an HTTP response.
        static func response(fromForwarded raw: String?) -> PuppetReply {
            guard let raw else {
                return refusal(503, "the editor webview has no puppet inspector yet; retry")
            }
            guard
                let object = try? JSONSerialization.jsonObject(with: Data(raw.utf8))
                    as? [String: Any],
                let status = object["status"] as? Int
            else {
                return refusal(502, "the webview returned something other than {status, body}")
            }
            return (status, json(object["body"] ?? NSNull()))
        }

        static func reasonPhrase(for status: Int) -> String {
            switch status {
            case 200: return "OK"
            case 400: return "Bad Request"
            case 404: return "Not Found"
            case 409: return "Conflict"
            case 413: return "Payload Too Large"
            case 502: return "Bad Gateway"
            case 503: return "Service Unavailable"
            default: return "Internal Server Error"
            }
        }
    }
#endif
