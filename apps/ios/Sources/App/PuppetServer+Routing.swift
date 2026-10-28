#if DEBUG
    import Foundation

    extension PuppetServer {
        @MainActor
        func perform(_ route: PuppetRoute, body: Data) async -> PuppetReply {
            switch route {
            case .actions:
                return await actions()
            case .tree:
                var tree = PuppetScreenReader.tree()
                tree["controls"] = controlLabels()
                tree.merge(PuppetServerContract.aim(webview: webviewOnScreen())) { _, aim in aim }
                return (200, PuppetServerContract.json(tree))
            case .verb(let name):
                let registered = PuppetVerbs.shared.verb(named: name)
                // A modal sheet covers the app: only its own verbs reach anything.
                if PuppetVerbs.shared.modalUp, registered == nil {
                    return PuppetServerContract.refusal(
                        404,
                        "a sheet is open; \(name) is behind it. On screen: "
                            + PuppetVerbs.shared.all.map(\.name).joined(separator: ", "))
                }
                if PuppetServerContract.nativeVerbs.contains(name) {
                    return await nativeVerb(name, body: body)
                }
                // A control on the SwiftUI screen itself: registered while that screen is up,
                // so being registered IS being on this screen.
                if let registered { return await screenVerb(registered, body: body) }
                guard editorNote != nil else {
                    return PuppetServerContract.refusal(
                        404, "\(name) needs an open editor; none is on the navigation stack")
                }
                if let refusal = await awaitEditorLoaded(for: name) { return refusal }
                // The editor's rename alert, which has no verbs, takes a touch before the page.
                guard webviewOnScreen() != nil else {
                    return PuppetServerContract.refusal(
                        503,
                        "\(name) is the editor's, and a sheet or a dialog is over it; "
                            + "answer it or GoBack first")
                }
                let wrapped = PuppetServerContract.json([
                    "verb": name, "args": (try? JSONSerialization.jsonObject(with: body)) ?? [:],
                ])
                return await forward("do", argsJson: String(decoding: wrapped, as: UTF8.self))
            case .query("state"):
                return await state()
            case .query("notes"):
                let withTimes =
                    PuppetServerContract.decodeArguments(from: body)["modified"] as? Bool
                    == true
                return (200, PuppetServerContract.json(vault(modified: withTimes)))
            case .query("touches"):
                return (200, PuppetServerContract.json(PuppetTouches.since(body)))
            case .query("search"):
                return await search(body: body)
            case .query("file"):
                return await file(body: body)
            case .query("observe"):
                return await observe()
            case .query(let command):
                if PuppetServerContract.pageQueries.contains(command),
                    let refusal = requirePage(for: command)
                {
                    return refusal
                }
                return await forward(
                    command, argsJson: body.isEmpty ? "{}" : String(decoding: body, as: UTF8.self))
            }
        }
    }
#endif
