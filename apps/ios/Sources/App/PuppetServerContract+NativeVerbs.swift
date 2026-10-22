#if DEBUG
    import Foundation

    extension PuppetServerContract {
        /// Navigation the shell owns — a row's tap, Back, the screens' entries — and the
        /// Settings sheet's values, each with the catalog keys of its controls' labels
        /// (`PuppetVerbs.Verb.controls`): a row reads `→ Verb`, and `just check-puppet-verbs`
        /// holds each labelled control to a verb. A list's New note and New folder, its dialogs
        /// and its move sheets are the list screen's own verbs (NoteListView.swift). Every
        /// argument is a string; `schema(_:optional:)` says which are required.
        static let nativeControls: KeyValuePairs<String, [String]> = [
            "OpenNote": [],
            "GoBack": ["common.actions.done"],
            "OpenFolder": [],
            // The root list's nav bar and search field, then the Settings and Sync
            // sheets — the same names the desktop shell registers for the same acts.
            "OpenSettings": ["settings.heading"],
            "OpenSync": ["sync.heading", "settings.sync.label"],
            "OpenFeedback": ["settings.issueReporting.sendFeedback"],
            "SetSearchQuery": [],
            "ClearSearchQuery": [],
            "SetTheme": ["settings.appearance.theme"],
            "ToggleIssueReporting": ["settings.issueReporting.shareCrashReports"],
            "ToggleAlwaysSendReports": ["settings.issueReporting.sendAutomatically"],
        ]
        static let nativeVerbs = nativeControls.map(\.key)

        /// Verbs by what their controls' labels read (`resolve` is the app's catalog lookup).
        static func controlLabels(
            _ verbs: [(name: String, controls: [String])], resolve: (String) -> String
        ) -> [String: [String]] {
            var byLabel: [String: [String]] = [:]
            for (name, keys) in verbs {
                for key in keys where !(byLabel[resolve(key)] ?? []).contains(name) {
                    byLabel[resolve(key), default: []].append(name)
                }
            }
            return byLabel
        }

        /// One `/actions` entry for a screen's own verb: a convenience verb says it is one, and
        /// a verb with shortcut arguments says which steps each stands for (`[[verb, {args}], …]`).
        /// The listener's own verbs (`nativeActions`) declare no shortcuts. Same shape as
        /// Android's `actionEntry`.
        static func actionEntry(_ verb: PuppetVerbs.Verb) -> [String: Any] {
            var action: [String: Any] = [
                "name": verb.name,
                "schema": schema(
                    verb.required, optional: verb.optional, integers: verb.integers,
                    booleans: verb.booleans),
            ]
            if verb.convenience { action["convenience"] = true }
            if !verb.shortcuts.isEmpty {
                action["shortcuts"] = verb.shortcuts.mapValues { steps in
                    steps.map { [$0.verb, $0.arguments] as [Any] }
                }
            }
            return action
        }

        /// The shell's verbs for this navigation state, JSON Schema each, no prose.
        /// A sheet covers the browser, so while one is up only its verbs are offered.
        static func nativeActions(path: [Route], sheet: PresentedSheet? = nil) -> [[String: Any]] {
            func verb(_ name: String, _ required: [String] = [], optional: [String] = [])
                -> [String: Any]
            {
                ["name": name, "schema": schema(required, optional: optional)]
            }
            let back = verb("GoBack")
            switch sheet {
            case .settingsFeedback:
                // The composer registers its own controls' verbs while it is up
                // (FeedbackView), so the shell's list is just the way back out.
                return [back]
            case .settings:
                return [
                    verb("OpenSync"), verb("OpenFeedback"), verb("SetTheme", ["theme"]),
                    verb("ToggleIssueReporting"), verb("ToggleAlwaysSendReports"), back,
                ]
            case .sync, .settingsSync:
                // The sheet's own controls are the verbs its sections register (hosted sync,
                // and the self-hosted fields once they are on screen).
                return [back]
            case .none:
                break
            }
            // An open editor is a screen of its own: it has no note list and no rows, so none
            // of the list's verbs are on it. The editor screen registers what it does have (the
            // title field, the find bar) through PuppetVerbs. Offered here regardless, they
            // answered 503 on contact and cost a driver two seconds each.
            if path.last?.editorNote != nil { return [back] }
            // A row's tap. The rows' context menus and swipe actions are the system's, reached
            // by real touch; New note and New folder are the list screen's own verbs.
            var actions = [verb("OpenNote", ["noteId"]), verb("OpenFolder", ["path"])]
            if path.isEmpty {
                // The root list's nav-bar buttons and search field.
                actions += [
                    verb("OpenSettings"), verb("OpenSync"), verb("SetSearchQuery", ["query"]),
                    verb("ClearSearchQuery"),
                ]
            } else {
                actions.append(back)
            }
            return actions
        }

        /// Why `name` is not here. From the editor, the list's verbs are one GoBack away, and a
        /// bare "no such verb" sent a driver round the same refusal until it gave up.
        static func offScreen(_ name: String, path: [Route]) -> String {
            let listNames = nativeActions(path: []).compactMap { $0["name"] as? String }
            if path.last?.editorNote != nil, listNames.contains(name) {
                return "\(name) is on the note list, and the editor is its own screen: GoBack first"
            }
            return "no such verb on this screen: \(name)"
        }

        /// Why a note or folder cannot be opened from this screen: its row is elsewhere.
        static func noRowHere(_ item: String, in folder: String) -> String {
            let home = folder.isEmpty ? "the top-level list" : "folder `\(folder)`"
            return "`\(item)` has no row on this screen: it is in \(home). Open that folder "
                + "first (GoBack, or a folder row), then its row"
        }

        static func parentFolder(of path: String) -> String {
            guard let slash = path.lastIndex(of: "/") else { return "" }
            return String(path[..<slash])
        }
    }
#endif
