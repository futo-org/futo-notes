#if DEBUG
    import Foundation
    import UIKit

    extension PuppetServer {
        /// What a user sees: the screen, the sheet, the search, the settings and
        /// sync values, and — with an editor open under no sheet — the editor's own
        /// `state`, merged, so one call answers the same questions it does on desktop.
        @MainActor
        func state() async -> PuppetReply {
            let page = await pageObject("state")
            return (200, PuppetServerContract.json(await stateObject(page: page)))
        }

        /// The screen on top, as `state` and `actions` name it.
        @MainActor
        private var screenName: String {
            PuppetServerContract.screen(
                path: navigation.path, sheet: navigation.sheet,
                searchQuery: navigation.searchQuery, openNote: PuppetVerbs.shared.openNote)
        }

        /// The note whose editor is on top of the navigation stack, if one is.
        @MainActor
        var editorNote: String? { navigation.path.last?.editorNote }

        /// The app's own search, best first — the engine the search screen runs — for the notes
        /// the vault still has.
        @MainActor
        func search(body: Data) async -> PuppetReply {
            guard let request = PuppetServerContract.searchRequest(from: body) else {
                return PuppetServerContract.refusal(
                    400,
                    #"search needs {"query":"…"}, and "limit" if given is a positive whole number"#)
            }
            let known = Set(store.notes.map(\.id))
            let hits = await store.search(request.query, limit: request.limit)
                .map(\.noteId).filter(known.contains)
            return (200, PuppetServerContract.json(["query": request.query, "hits": hits]))
        }

        /// `file {"noteId", "save"?}`: the note's markdown as it is on disk, read once the open
        /// editor's edits are written, so they are in it; refused while they are not on disk.
        /// `"save":false` reads the disk as it is, writing nothing. The CLI narrows it to lines
        /// or matches.
        @MainActor
        func file(body: Data) async -> PuppetReply {
            let arguments = PuppetServerContract.decodeArguments(from: body)
            guard let noteId = arguments["noteId"] as? String, !noteId.isEmpty
            else { return PuppetServerContract.refusal(400, #"file needs {"noteId":"…"}"#) }
            if arguments["save"] as? Bool ?? true {
                await store.flushPendingEditorAndWait()
                if store.unsavedNoteIds.contains(noteId) {
                    return PuppetServerContract.refusal(
                        409,
                        "\"\(noteId)\" has edits that did not save, so its file is not what the "
                            + #"editor shows; "save":false reads the disk as it is"#)
                }
            }
            do {
                // Only an id `notes` lists: a case-insensitive disk would read "Work/Retro" as
                // work/retro.
                guard store.notes.contains(where: { $0.id == noteId }),
                    let text = try await store.readIfExists(noteId)
                else {
                    return PuppetServerContract.refusal(
                        404, "no note \"\(noteId)\" in the vault; `notes` lists every one")
                }
                return (200, PuppetServerContract.json(["noteId": noteId, "text": text]))
            } catch {
                return PuppetServerContract.refusal(500, "reading \"\(noteId)\" failed: \(error)")
            }
        }

        /// The search screen's rows: the list's own query, run as the list runs it. Nil when
        /// the query is blank, so the list shows its folders instead.
        @MainActor
        func searchHits() async -> [String]? {
            let query = navigation.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !query.isEmpty else { return nil }
            return await store.search(query, limit: 50).map(\.noteId)
        }

        /// The vault the store holds, whatever the list is drawing.
        @MainActor
        func vault(modified: Bool = false) -> [String: Any] {
            PuppetServerContract.vault(
                noteIds: store.notes.map(\.id), folders: store.folders,
                modified: modified
                    ? Dictionary(
                        store.notes.map { ($0.id, Int($0.modified.timeIntervalSince1970 * 1000)) },
                        uniquingKeysWith: { first, _ in first })
                    : nil)
        }

        /// Everything a one-decision-per-turn controller needs in one call, the same
        /// shape `observe` answers with on desktop: the state, the vault, the verbs on
        /// this screen, and — with the editor up — its document and rows. `futo-puppet
        /// step` is built on this, so `drive` works here exactly as it does on desktop.
        @MainActor
        func observe() async -> PuppetReply {
            // One page call: its `observe` carries its `state`'s editor and its verbs too.
            let page = await pageObject("observe")
            var object = await stateObject(page: page)
            for (key, value) in vault() { object[key] = value }
            // The page owns the document and its own rows, which are on screen only while
            // nothing covers it; the shell owns everything else, including this screen's verbs.
            let shown = webviewOnScreen() != nil ? page : nil
            object["actions"] = actionsList(pageActions: shown?["actions"])
            object["lines"] = shown?["lines"] ?? [Any]()
            object["elements"] = shown?["elements"] ?? [Any]()
            return (200, PuppetServerContract.json(object))
        }

        /// `page` is the editor page's answer to `state` or `observe`, whose keys the shell's
        /// own do not overwrite.
        @MainActor
        private func stateObject(page: [String: Any]?) async -> [String: Any] {
            typealias Contract = PuppetServerContract
            var object: [String: Any] = [
                "screen": screenName,
                "sheet": navigation.sheet.map { Contract.screen(path: [], sheet: $0) } ?? NSNull(),
                // Every screen under the sheet, root first, as `screen` names it: where each
                // GoBack leads, which futo-puppet counts to bring a row's folder on screen.
                "stack": (0...navigation.path.count).map { depth in
                    Contract.screen(
                        path: Array(navigation.path.prefix(depth)),
                        searchQuery: navigation.searchQuery,
                        openNote: depth == navigation.path.count ? PuppetVerbs.shared.openNote : nil
                    )
                },
                // As stored, whole: a receipt shows any setting an action changes, picked or not.
                "settings": Contract.storedSettings(
                    UserDefaults.standard.dictionaryRepresentation()),
                "sync": [
                    "connected": sync.connected, "live": sync.live,
                    "status": sync.statusMessage.path,
                    "lastError": sync.lastErrorMessage?.path ?? NSNull(),
                ],
                // Work still in flight: an action whose receipt shows this has not finished yet.
                "pending": ["unsaved": store.unsavedNoteIds, "sync": sync.busy],
                "copied": PuppetVerbs.shared.copied.map { ["count": $0.count, "text": $0.text] }
                    ?? NSNull(),
                "opened": PuppetVerbs.shared.opened.map { ["count": $0.count, "url": $0.url] }
                    ?? NSNull(),
                // The banner on screen, "" when none, as desktop reports its toast.
                "toast": store.transientMessage.map {
                    EditorHost.shared.desiredLocalization.localizedText(
                        $0.path, arguments: $0.arguments)
                } ?? "",
                // Whether the app is on screen at all, and whether the keyboard is up: neither
                // shows in the rows.
                "foreground": UIApplication.shared.applicationState == .active,
                "keyboard": Self.keyboardUp,
            ]
            if navigation.path.isEmpty {
                // The same store query the list runs, so `hits` is what the rows show.
                let hits = await searchHits() ?? []
                object["search"] = ["query": navigation.searchQuery, "hits": hits]
            }
            for (key, value) in page ?? [:] where object[key] == nil { object[key] = value }
            return object
        }

        @MainActor
        func actions() async -> PuppetReply {
            var pageActions: Any?
            if !PuppetVerbs.shared.modalUp, webviewOnScreen() != nil {
                pageActions = await pageObject("actions")?["actions"]
            }
            return (
                200,
                PuppetServerContract.json([
                    "screen": screenName,
                    "actions": actionsList(pageActions: pageActions),
                ])
            )
        }

        /// What this screen's verbs' controls read now, in the app's language, each with the
        /// verbs it stands for: `/tree`'s `controls`, which futo-puppet matches rows against to
        /// print `→ Verb`. The verbs are `/actions`' own: the listener's for this screen, and the
        /// screen's registered ones (a sheet's alone while a modal one is up).
        @MainActor
        func controlLabels() -> [String: [String]] {
            typealias Contract = PuppetServerContract
            let localization = EditorHost.shared.desiredLocalization
            let native =
                PuppetVerbs.shared.modalUp
                ? []
                : Contract.nativeActions(path: navigation.path, sheet: navigation.sheet)
                    .compactMap { $0["name"] as? String }
                    .map { name in
                        (name, Contract.nativeControls.first { $0.key == name }?.value ?? [])
                    }
            return Contract.controlLabels(
                native + PuppetVerbs.shared.all.map { ($0.name, $0.controls) },
                resolve: { localization.localizedText($0) })
        }

        /// `pageActions` is the editor page's verbs, given only while nothing covers it.
        @MainActor
        private func actionsList(pageActions: Any?) -> [[String: Any]] {
            let modal = PuppetVerbs.shared.modalUp
            var actions =
                modal
                ? []
                : PuppetServerContract.nativeActions(
                    path: navigation.path, sheet: navigation.sheet)
            // A sheet covers the editor, so its verbs are not on this screen.
            if !modal, let editorActions = pageActions as? [[String: Any]] {
                actions += editorActions
            }
            // The screens' own controls, from whatever is on top right now.
            return actions + PuppetVerbs.shared.all.map(PuppetServerContract.actionEntry)
        }
    }
#endif
