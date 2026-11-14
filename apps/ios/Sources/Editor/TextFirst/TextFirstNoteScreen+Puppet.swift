import SwiftUI

extension TextFirstNoteScreen {
    #if DEBUG
        var nativePuppetVerbs: [PuppetVerbs.Verb] {
            guard let controller, !leaving, !controller.engineBusy else { return [] }
            var verbs = [
                PuppetVerbs.Verb(
                    "SetTitle", required: ["title"],
                    controls: ["notes.title.fieldLabel", "common.actions.rename"]
                ) { args in
                    _ = try PuppetNativeEditor.shared.requireController()
                    let (stripped, forbidden) = TitleTextField.Coordinator.stripped(
                        args["title"] as? String ?? "")
                    let typed = String(stripped.prefix(TitleSpec.maxLength))
                    guard !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        throw PuppetVerbRefusal(400, "the title has nothing a note title can hold")
                    }
                    titleField = typed
                    titleChanged(typed)
                    renameTask?.cancel()
                    if forbidden {
                        store.showTransient(LocalizedMessage("notes.title.forbiddenCharacter"))
                    }
                    await renameTo(typed)
                    guard
                        splitId(id: controller.noteId).title
                            == sanitizeTitle(
                                title: typed.trimmingCharacters(in: .whitespacesAndNewlines))
                    else {
                        throw PuppetVerbRefusal(
                            409,
                            "the title was refused; the native title field retains it for correction"
                        )
                    }
                    return ["noteId": controller.noteId]
                },
                PuppetVerbs.Verb("OpenFind", controls: ["editor.find.open"]) {
                    _ = try PuppetNativeEditor.shared.requireController()
                    controller.openFind()
                },
            ]
            if controller.findModel.visible {
                verbs += [
                    PuppetVerbs.Verb(
                        "SetFindQuery", optional: ["query"],
                        controls: ["editor.find.queryHint", "editor.find.clearQuery"]
                    ) { args in
                        controller.findModel.query = args["query"] as? String ?? ""
                        controller.setFindQuery(controller.findModel.query)
                        return ["query": controller.findModel.query]
                    },
                    PuppetVerbs.Verb(
                        "StepFind", required: ["direction"], integers: ["direction"],
                        controls: ["editor.find.previousMatch", "editor.find.nextMatch"]
                    ) { args in
                        let direction = args["direction"] as? Int ?? 0
                        guard direction == 1 || direction == -1 else {
                            throw PuppetVerbRefusal(400, "direction is 1 or -1")
                        }
                        controller.stepFind(forward: direction == 1)
                        return ["direction": direction]
                    },
                    PuppetVerbs.Verb("CloseFind", controls: ["editor.find.close"]) {
                        controller.closeFind()
                    },
                ]
            }
            return verbs
        }
    #endif
}
