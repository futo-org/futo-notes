import Foundation
import Testing

@testable import FutoNotesNative

#if DEBUG
    @Suite("futo-puppet listener contract")
    struct PuppetServerContractTests {
        @Test("no port in the environment means no listener at all")
        func requiresAnExplicitPort() {
            #expect(PuppetServerContract.resolvePort(environment: [:]) == .absent)
            #expect(
                PuppetServerContract.resolvePort(environment: ["FUTO_PUPPET_PORT": "   "])
                    == .absent
            )
        }

        @Test("an explicit port is used verbatim; a malformed one is refused, never redirected")
        func parsesPorts() {
            #expect(
                PuppetServerContract.resolvePort(environment: ["FUTO_PUPPET_PORT": " 9440 "])
                    == .port(9440)
            )
            for raw in ["0", "-1", "70000", "nine"] {
                #expect(
                    PuppetServerContract.resolvePort(environment: ["FUTO_PUPPET_PORT": raw])
                        == .invalid(raw)
                )
            }
        }

        @Test("search takes a query as sent and a positive limit, 10 unless given")
        func searchRequests() {
            let request = { (json: String) in
                PuppetServerContract.searchRequest(from: Data(json.utf8))
            }
            #expect(request(#"{"query":"lease "}"#)?.query == "lease ")
            #expect(request(#"{"query":"lease "}"#)?.limit == 10)
            #expect(request(#"{"query":"lease","limit":3}"#)?.limit == 3)
            for refused in [
                #"{}"#, #"{"query":"  "}"#, #"{"query":"x","limit":0}"#,
                #"{"query":"x","limit":"3"}"#,
            ] {
                #expect(request(refused) == nil)
            }
        }

        @Test("an answer is confirm or dismiss wherever a verb takes one")
        func answerIsAnEnum() {
            let schema = PuppetServerContract.schema(["noteId"], optional: ["answer"])
            let answer = (schema["properties"] as? [String: Any])?["answer"] as? [String: Any]
            #expect(answer?["enum"] as? [String] == ["confirm", "dismiss"])
        }

        @Test("a reply holding a value JSON cannot is refused, never an abort")
        func invalidReplyIsRefused() throws {
            struct NotJSON {}
            let body = PuppetServerContract.json(["ok": true, "noteId": NotJSON()])
            let reply = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            #expect(reply["ok"] as? Bool == false)
        }

        @Test("routes: the manifest, any verb, the published queries, nothing else")
        func routes() {
            #expect(PuppetServerContract.route(method: "get", path: "/actions") == .actions)
            #expect(
                PuppetServerContract.route(method: "POST", path: "/do/OpenNote")
                    == .verb("OpenNote"))
            #expect(
                PuppetServerContract.route(method: "POST", path: "/do/Select")
                    == .verb("Select"))
            // `futo-puppet step` — so `drive` — needs observe, notes and clipboard; a receipt
            // asks touches whether a tap reached the app.
            for query in [
                "elements", "at", "trace", "search", "observe", "notes", "clipboard", "touches",
            ] {
                #expect(
                    PuppetServerContract.route(method: "POST", path: "/\(query)") == .query(query))
            }
            #expect(PuppetServerContract.route(method: "GET", path: "/tree") == .tree)
            #expect(PuppetServerContract.route(method: "GET", path: "/frame") == nil)
            #expect(PuppetServerContract.route(method: "POST", path: "/tree") == nil)
            #expect(PuppetServerContract.route(method: "POST", path: "/do/") == nil)
            #expect(PuppetServerContract.route(method: "POST", path: "/actions") == nil)
            #expect(PuppetServerContract.route(method: "GET", path: "/elements") == nil)
            #expect(PuppetServerContract.route(method: "POST", path: "/nope") == nil)
        }

        @Test("the tree's aim: the webview's rounded rect or null, and the simulator UDID")
        func aim() {
            let body = PuppetServerContract.aim(
                webview: CGRect(x: 0.4, y: 103.6, width: 402, height: 560.2),
                environment: ["SIMULATOR_UDID": "ABC"])
            let webview = body["webview"] as? [String: Int]
            #expect(webview == ["x": 0, "y": 104, "w": 402, "h": 560])
            #expect(body["udid"] as? String == "ABC")
            // A native screen: no webview to aim into.
            let bare = PuppetServerContract.aim(webview: nil, environment: [:])
            #expect(bare["webview"] is NSNull)
            #expect(bare["udid"] is NSNull)
        }

        @Test("native verbs follow the navigation state, each with a JSON Schema and no prose")
        func nativeActions() {
            let root = PuppetServerContract.nativeActions(path: [])
            let names = root.compactMap { $0["name"] as? String }
            // A row's tap, then the nav bar's buttons and the search field. New note, New folder
            // and the move sheets are verbs the list screen registers itself; the rows' context
            // menus and swipe actions are the system's, reached by real touch.
            #expect(
                names == [
                    "OpenNote", "OpenFolder", "OpenSettings", "OpenSync", "SetSearchQuery",
                    "ClearSearchQuery",
                ])
            #expect(Set(names).isSubset(of: PuppetServerContract.nativeVerbs))
            // A pushed folder has no nav-bar buttons and no search field, only Back.
            let inFolder = PuppetServerContract.nativeActions(path: [.folder("a")])
                .compactMap { $0["name"] as? String }
            #expect(!inFolder.contains("OpenSettings") && inFolder.last == "GoBack")
            let openNote = root[0]["schema"] as? [String: Any]
            #expect(openNote?["required"] as? [String] == ["noteId"])
            #expect(root[0]["description"] == nil)

            // An open editor is its own screen: no note list and no rows, so none of the list's
            // verbs are on it. What it does have, the editor screen registers for itself (the
            // title field, the find bar) through PuppetVerbs.
            for editor in [Route.note("a"), Route.newNote("a")] {
                let inEditor = PuppetServerContract.nativeActions(path: [editor])
                #expect(inEditor.compactMap { $0["name"] as? String } == ["GoBack"])
            }
        }

        @Test("a list verb refused in the editor says to GoBack first")
        func offScreenFromTheEditor() {
            #expect(
                PuppetServerContract.offScreen("OpenNote", path: [.note("a")]).contains(
                    "GoBack first"))
            #expect(
                PuppetServerContract.offScreen("Frobnicate", path: [.note("a")])
                    == "no such verb on this screen: Frobnicate")
            #expect(
                PuppetServerContract.offScreen("OpenNote", path: [])
                    == "no such verb on this screen: OpenNote")
        }

        @Test("a folder's parent is the path above it")
        func parentFolder() {
            #expect(PuppetServerContract.parentFolder(of: "work/q3") == "work")
            #expect(PuppetServerContract.parentFolder(of: "work") == "")
        }

        @Test("screen names the top of the navigation stack")
        func screens() {
            #expect(PuppetServerContract.screen(path: []) == "list")
            #expect(PuppetServerContract.screen(path: [.folder("a/b")]) == "folder:a/b")
            #expect(
                PuppetServerContract.screen(path: [.folder("a"), .note("a/x")])
                    == "editor:a/x")
            #expect(PuppetServerContract.screen(path: [.newNote("n")]) == "editor:n")
        }

        @Test("a sheet or a search is the screen the user sees, whatever the stack holds")
        func sheetsAndSearchAreScreens() {
            typealias Contract = PuppetServerContract
            #expect(Contract.screen(path: [.note("x")], sheet: .settings) == "settings")
            #expect(Contract.screen(path: [], sheet: .sync) == "sync")
            #expect(Contract.screen(path: [], sheet: .settingsSync) == "sync")
            #expect(Contract.screen(path: [], searchQuery: " fox ") == "search")
            // A pushed folder hides the search field, so a stale query is not a screen.
            #expect(Contract.screen(path: [.folder("a")], searchQuery: "fox") == "folder:a")

            let settings = Contract.nativeActions(path: [], sheet: .settings)
                .compactMap { $0["name"] as? String }
            #expect(
                settings == [
                    "OpenSync", "OpenFeedback", "SetTheme", "ToggleIssueReporting",
                    "ToggleAlwaysSendReports", "GoBack",
                ])
            // Feedback is a push inside Settings: it is the screen, and Back is its one verb.
            #expect(Contract.screen(path: [], sheet: .settingsFeedback) == "feedback")
            #expect(
                Contract.nativeActions(path: [], sheet: .settingsFeedback)
                    .compactMap { $0["name"] as? String } == ["GoBack"])
            let sync = Contract.nativeActions(path: [.note("x")], sheet: .settingsSync)
                .compactMap { $0["name"] as? String }
            #expect(sync == ["GoBack"])
            #expect(Set(settings + sync).isSubset(of: Contract.nativeVerbs))
        }

        @Test("a screen verb's shortcuts are the steps each argument stands for, `$` its value")
        @MainActor
        func actionEntryShortcuts() {
            let verb = PuppetVerbs.Verb(
                "OpenCreateFolderDialog", optional: ["name"], controls: ["folders.newFolder"],
                shortcuts: [
                    "name": [("SetNewFolderName", ["name": "$"]), ("SubmitNewFolder", [:])]
                ]
            ) { _ in [:] }
            let entry = PuppetServerContract.actionEntry(verb)
            let shortcuts = PuppetServerContract.json(entry["shortcuts"] ?? NSNull())
            #expect(
                String(decoding: shortcuts, as: UTF8.self)
                    == #"{"name":[["SetNewFolderName",{"name":"$"}],["SubmitNewFolder",{}]]}"#)
            #expect(entry["name"] as? String == "OpenCreateFolderDialog")
            let schema = entry["schema"] as? [String: Any]
            #expect((schema?["properties"] as? [String: Any])?.keys.sorted() == ["name"])
            #expect(schema?["required"] as? [String] == [])
            #expect(entry["convenience"] == nil)
            // A verb without shortcuts says nothing of them.
            let plain = PuppetServerContract.actionEntry(
                PuppetVerbs.Verb("CreateNote", controls: ["notes.newNote"]) { _ in [:] })
            #expect(plain["shortcuts"] == nil)
        }

        @Test("the forward script quotes both arguments as JS string literals")
        func forwardScript() {
            let script = PuppetServerContract.forwardScript(
                command: "do", argsJson: #"{"verb":"Select","args":{"expect":"a\"b"}}"#)
            #expect(
                script
                    == #"window.__futoPuppet ? window.__futoPuppet.run("do", "{\"verb\":\"Select\",\"args\":{\"expect\":\"a\\\"b\"}}") : null"#
            )
        }

        @Test("a forwarded reply becomes the HTTP status and body it names")
        func relaysForwardedReplies() throws {
            let relayed = PuppetServerContract.response(
                fromForwarded: #"{"status":409,"body":{"ok":false,"error":"moved"}}"#)
            #expect(relayed.status == 409)
            let body = try JSONSerialization.jsonObject(with: relayed.body) as? [String: Any]
            #expect(body?["error"] as? String == "moved")

            #expect(PuppetServerContract.response(fromForwarded: nil).status == 503)
            #expect(PuppetServerContract.response(fromForwarded: "garbage").status == 502)
        }

        @Test("a request is parsed only once its declared body has arrived")
        func parsesRequestsIncrementally() throws {
            let full = Data(
                "POST /do/OpenNote HTTP/1.1\r\nContent-Length: 14\r\n\r\n{\"noteId\":\"a\"}".utf8)
            let request = try #require(PuppetHTTPRequest(full))
            #expect(request.method == "POST")
            #expect(request.path == "/do/OpenNote")
            #expect(request.body == Data(#"{"noteId":"a"}"#.utf8))

            let truncated = Data(
                "POST /do/OpenNote HTTP/1.1\r\nContent-Length: 14\r\n\r\n{\"noteId\":".utf8)
            #expect(PuppetHTTPRequest(truncated) == nil)
            // What an oversized request still has to send, read before it is answered 413.
            #expect(PuppetHTTPRequest.declaredSize(truncated) == full.count)
            #expect(PuppetHTTPRequest.declaredSize(Data("POST /do/X HTTP/1.1\r\n".utf8)) == nil)

            let noBody = try #require(PuppetHTTPRequest(Data("GET /actions HTTP/1.1\r\n\r\n".utf8)))
            #expect(noBody.body.isEmpty)
        }

        @Test("a request over the size limit is answered Payload Too Large")
        func oversizedReason() {
            #expect(PuppetServerContract.reasonPhrase(for: 413) == "Payload Too Large")
        }

        @Test("a required argument is the kind its schema declares, as Android checks it")
        func argumentKinds() {
            let arguments = PuppetServerContract.decodeArguments(
                from: Data(#"{"title":"x","blank":" ","five":5,"yes":true,"zero":"0"}"#.utf8))
            func has(_ key: String, integer: Bool = false, boolean: Bool = false) -> Bool {
                PuppetServerContract.hasKind(key, in: arguments, integer: integer, boolean: boolean)
            }
            #expect(has("title"))
            #expect(!has("blank"))
            #expect(!has("five"))
            #expect(has("five", integer: true))
            #expect(!has("zero", integer: true))
            #expect(!has("yes", integer: true))
            #expect(has("yes", boolean: true))
            #expect(!has("five", boolean: true))
            #expect(!has("missing", boolean: true))
        }

        @Test("only the page's own queries are page-bound; the vault and the clipboard are not")
        func pageBoundQueries() {
            #expect(PuppetServerContract.pageQueries.contains("doc"))
            #expect(PuppetServerContract.pageQueries.contains("elements"))
            for shellQuery in ["state", "notes", "observe", "clipboard", "touches"] {
                #expect(!PuppetServerContract.pageQueries.contains(shellQuery))
            }
            #expect(
                PuppetServerContract.pageQueries.isSubset(of: Set(PuppetServerContract.queries)))
        }

        @Test("the vault is sorted ids and folders, whatever order the store holds them in")
        func vault() {
            let body = PuppetServerContract.vault(
                noteIds: ["work/standup", "welcome"], folders: ["work", "archive"])
            #expect(body["notes"] as? [String] == ["welcome", "work/standup"])
            #expect(body["folders"] as? [String] == ["archive", "work"])
            #expect(body["modified"] == nil)
            // The vault carries each note's time only when asked: a receipt diffs by it.
            let timed = PuppetServerContract.vault(
                noteIds: ["welcome"], folders: [], modified: ["welcome": 1_700_000_000_000])
            #expect(timed["modified"] as? [String: Int] == ["welcome": 1_700_000_000_000])
        }

        @Test("controls are each verb by what its labels read in the app's language")
        func controlLabels() {
            let labels = PuppetServerContract.controlLabels(
                [
                    ("DeleteNote", ["common.actions.delete"]),
                    ("DeleteFolder", ["common.actions.delete"]),
                    ("GoBack", ["common.actions.back"]), ("OpenNote", []),
                ],
                resolve: {
                    ["common.actions.delete": "Löschen", "common.actions.back": "Zurück"][$0]!
                })
            #expect(labels == ["Löschen": ["DeleteNote", "DeleteFolder"], "Zurück": ["GoBack"]])
        }

        @Test("settings are every futo key and the language list, JSON-safe, the license masked")
        func storedSettings() {
            let settings = PuppetServerContract.storedSettings([
                "futo.themeMode": "dark", "futo.stamp": Date(timeIntervalSince1970: 2),
                "futo.blob": Data([1]), "AppleLanguages": ["en"], "NSInterfaceStyle": "macintosh",
                "futo.license.key": "ABCD-EFGH-6UJV", "futo.license.activation": "signed-bytes",
            ])
            // As the License card shows them: the key masked to its last group, no activation.
            #expect(settings["futo.license.key"] as? String == "····-····-6UJV")
            #expect(settings["futo.license.activation"] as? String == "set")
            #expect(settings["futo.themeMode"] as? String == "dark")
            #expect(settings["futo.stamp"] as? Int == 2000)
            #expect(settings["futo.blob"] as? String == "set")
            #expect(settings["AppleLanguages"] as? [String] == ["en"])
            #expect(settings["NSInterfaceStyle"] == nil)
            #expect(JSONSerialization.isValidJSONObject(settings))
        }

    }
#endif
