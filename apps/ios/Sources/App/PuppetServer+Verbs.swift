#if DEBUG
    import Foundation

    extension PuppetServer {
        /// A verb's 200: `ok`, its name, and what it reports, which wins a clash.
        private func receipt(_ verb: String, _ reported: [String: Any] = [:]) -> PuppetReply {
            let object: [String: Any] = ["ok": true, "verb": verb]
            return (200, PuppetServerContract.json(object.merging(reported) { _, new in new }))
        }

        /// One verb the screen on top registered. Arguments are checked here so every
        /// screen's refusal reads the same as the shell's own.
        @MainActor
        func screenVerb(_ verb: PuppetVerbs.Verb, body: Data) async -> PuppetReply {
            typealias Contract = PuppetServerContract
            let arguments = Contract.decodeArguments(from: body)
            for key in verb.required
            where !Contract.hasKind(
                key, in: arguments, integer: verb.integers.contains(key),
                boolean: verb.booleans.contains(key))
            {
                let kind =
                    verb.integers.contains(key)
                    ? "an integer"
                    : verb.booleans.contains(key) ? "a boolean" : "a non-empty string"
                return Contract.refusal(400, "\(verb.name) requires \(kind) \(key)")
            }
            do {
                let reported = try await verb.run(arguments)
                return receipt(verb.name, reported)
            } catch let refusal as PuppetVerbRefusal {
                return Contract.refusal(refusal.status, refusal.message)
            } catch {
                return Contract.refusal(500, "\(verb.name) threw: \(error)")
            }
        }

        @MainActor
        func nativeVerb(_ name: String, body: Data) async -> PuppetReply {
            typealias Contract = PuppetServerContract
            let arguments = Contract.decodeArguments(from: body)
            func text(_ key: String) -> String? { Contract.text(key, in: arguments) }
            func required(_ key: String) throws -> String {
                guard let value = text(key) else {
                    throw PuppetVerbRefusal(400, "\(name) requires a non-empty string \(key)")
                }
                return value
            }
            /// A note that exists.
            func note(_ key: String) throws -> NoteItem {
                let id = try required(key)
                guard let found = store.notes.first(where: { $0.id == id }) else {
                    throw PuppetVerbRefusal(400, "no such note: \(id)")
                }
                return found
            }
            /// An existing folder path.
            func folder(_ key: String) throws -> String {
                let path = try required(key)
                guard store.folders.contains(path) else {
                    throw PuppetVerbRefusal(400, "no such folder: \(path)")
                }
                return path
            }
            do {
                // GoBack IS the app's Back button: popping the path runs the editor's
                // own exit (session end, draft flush) through onDisappear, as a tap does.
                if name == "GoBack" {
                    // Back under a dialog dismisses just the dialog. The scanner is a push
                    // inside the Sync sheet: its Back pops just it.
                    if let back = PuppetVerbs.shared.verb(named: "DismissDialog")
                        ?? PuppetVerbs.shared.verb(named: "CloseScanner")
                    {
                        _ = try await back.run([:])
                        return receipt(name)
                    }
                    // Done on a sheet; Sync opened from Settings lands back on Settings.
                    if let sheet = navigation.sheet {
                        navigation.sheet =
                            switch sheet {
                            case .settingsSync, .settingsFeedback: .settings
                            case .settings, .sync: nil
                            }
                        return receipt(name)
                    }
                    guard !navigation.path.isEmpty else {
                        throw PuppetVerbRefusal(400, "navigation stack is already at the root")
                    }
                    navigation.path.removeLast()
                    return receipt(name)
                }
                // A verb the user has no control for right now — a sheet covers the
                // list, or the search field is off-screen on a pushed folder.
                let onThisScreen = Contract.nativeActions(
                    path: navigation.path, sheet: navigation.sheet
                ).compactMap { $0["name"] as? String }
                guard onThisScreen.contains(name) else {
                    throw PuppetVerbRefusal(404, Contract.offScreen(name, path: navigation.path))
                }
                guard store.hasBootstrapped else {
                    throw PuppetVerbRefusal(503, "the note store has not finished loading; retry")
                }
                switch name {
                case "OpenSettings":
                    navigation.sheet = .settings
                    return receipt(name)
                case "OpenSync":
                    navigation.sheet = navigation.sheet == .settings ? .settingsSync : .sync
                    return receipt(name)
                case "OpenFeedback":
                    navigation.sheet = .settingsFeedback
                    return receipt(name)
                case "SetSearchQuery":
                    navigation.searchQuery = try required("query")
                    return receipt(name, ["query": navigation.searchQuery])
                case "ClearSearchQuery":
                    navigation.searchQuery = ""
                    return receipt(name)
                case "SetTheme":
                    // The picker writes this same key; @AppStorage observes the write.
                    let theme = try required("theme")
                    guard ThemeMode(rawValue: theme) != nil else {
                        throw PuppetVerbRefusal(400, "theme must be light, dark or auto")
                    }
                    UserDefaults.standard.set(theme, forKey: ThemeMode.storageKey)
                    return receipt(name, ["theme": theme])
                case "ToggleIssueReporting":
                    let enabled = !UserDefaults.standard.bool(forKey: CrashReporter.enabledKey)
                    UserDefaults.standard.set(enabled, forKey: CrashReporter.enabledKey)
                    return receipt(name, ["enabled": enabled])
                case "ToggleAlwaysSendReports":
                    guard UserDefaults.standard.bool(forKey: CrashReporter.enabledKey) else {
                        throw PuppetVerbRefusal(
                            409, "crash reporting is off; ToggleIssueReporting first")
                    }
                    let always = !UserDefaults.standard.bool(forKey: CrashReporter.alwaysSendKey)
                    UserDefaults.standard.set(always, forKey: CrashReporter.alwaysSendKey)
                    return receipt(name, ["alwaysSend": always])
                // OpenNote and OpenFolder are a tap on one of this screen's rows, so they push
                // what the row's NavigationLink pushes. A note in another folder has no row
                // here; opening it is a walk through its folders, as it is for a person.
                case "OpenNote":
                    let target = try note("noteId")
                    guard await rowsOnScreen().notes.contains(target.id) else {
                        throw PuppetVerbRefusal(
                            409, Contract.noRowHere(target.id, in: target.folder))
                    }
                    // The search behind the rows can suspend, and a tap can open an editor then.
                    guard editorNote == nil else {
                        throw PuppetVerbRefusal(
                            503, "an editor is open; GoBack before navigating elsewhere")
                    }
                    navigation.path.append(.note(target.id))
                    if let refusal = await awaitEditorLoaded(for: name) { return refusal }
                    return receipt(name, ["noteId": target.id])
                default:  // OpenFolder
                    let path = try folder("path")
                    guard await rowsOnScreen().folders.contains(path) else {
                        throw PuppetVerbRefusal(
                            409, Contract.noRowHere(path, in: Contract.parentFolder(of: path)))
                    }
                    navigation.path.append(.folder(path))
                    return receipt(name, ["path": path])
                }
            } catch let refusal as PuppetVerbRefusal {
                return Contract.refusal(refusal.status, refusal.message)
            } catch {
                return Contract.refusal(500, "\(name) threw: \(error)")
            }
        }

        /// The notes and folders the screen on top has rows for: a folder's own notes and
        /// subfolders, or the search results (notes only, the same query the list runs).
        @MainActor
        private func rowsOnScreen() async -> (notes: Set<String>, folders: Set<String>) {
            let folder: String
            switch navigation.path.last {
            case .note, .newNote:
                return ([], [])
            case .folder(let path):
                folder = path
            case .none:
                if let hits = await searchHits() { return (Set(hits), []) }
                folder = ""
            }
            return (Set(store.notes(in: folder).map(\.id)), Set(store.subfolders(of: folder)))
        }
    }
#endif
