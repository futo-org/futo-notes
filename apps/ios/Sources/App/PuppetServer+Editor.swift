#if DEBUG
    import Foundation
    import UIKit

    extension PuppetServer {
        @MainActor
        func forward(_ command: String, argsJson: String) async -> PuppetReply {
            PuppetNativeEditor.shared.reply(
                command,
                arguments: PuppetServerContract.decodeArguments(from: Data(argsJson.utf8)))
        }

        @MainActor
        func pageObject(_ command: String) async -> [String: Any]? {
            guard navigation.sheet == nil, editorNote != nil else { return nil }
            let adapter = PuppetNativeEditor.shared
            let note = PuppetVerbs.shared.openNote ?? editorNote
            if command == "state" { return ["editor": adapter.state(note: note)] }
            if command == "observe", !adapter.ready {
                return [
                    "editor": adapter.state(note: note), "lines": [Any](),
                    "elements": [Any](), "actions": [Any](),
                ]
            }
            let reply = await forward(command, argsJson: "{}")
            guard reply.status == 200 else { return nil }
            return try? JSONSerialization.jsonObject(with: reply.body) as? [String: Any]
        }

        @MainActor
        func requirePage(for action: String) -> PuppetReply? {
            guard navigation.sheet == nil, editorNote != nil else {
                return PuppetServerContract.refusal(503, "\(action) requires an uncovered editor")
            }
            do {
                _ = try PuppetNativeEditor.shared.requireController()
                return nil
            } catch let error as PuppetVerbRefusal {
                return PuppetServerContract.refusal(error.status, error.message)
            } catch {
                return PuppetServerContract.refusal(500, "native editor unavailable: \(error)")
            }
        }

        @MainActor
        func awaitEditorLoaded(for action: String) async -> PuppetReply? {
            guard editorNote != nil else { return nil }
            let deadline = Date().addingTimeInterval(3)
            while !PuppetNativeEditor.shared.ready {
                guard Date() < deadline else {
                    return PuppetServerContract.refusal(
                        503, "\(action): the native editor is still loading")
                }
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
            return nil
        }
    }
#endif
