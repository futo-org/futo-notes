import SwiftUI

extension NoteEditorView {
    var puppetVerbs: [PuppetVerbs.Verb] {
        // Asked afresh for every `actions` and every `do`, so this is what the screen can
        // do NOW: the find bar's three verbs exist only while the bar is up.
        var verbs: [PuppetVerbs.Verb] = [
            PuppetVerbs.Verb(
                "SetTitle", required: ["title"],
                controls: ["common.actions.rename", "notes.title.fieldLabel"]
            ) { arguments in
                // Typed as the field takes it: stripped and capped, then warned about. A
                // warning that blocks the rename (a dot, a duplicate) is the refusal.
                let (stripped, hadForbidden) = TitleTextField.Coordinator.stripped(
                    (arguments["title"] as? String) ?? "")
                let title = String(stripped.prefix(TitleSpec.maxLength))
                guard !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw PuppetVerbRefusal(400, "the title has nothing a note title can hold")
                }
                titleField = title
                handleTitleChange(title)
                if let warning = titleWarning {
                    throw PuppetVerbRefusal(
                        409, localization.localizedText(warning.path, arguments: warning.arguments))
                }
                if hadForbidden {
                    setTitleWarning(
                        LocalizedMessage("notes.title.forbiddenCharacter"), transient: true)
                }
                let renamed = await session.schedule(.rename, { await applyRename(title) })
                    .value
                guard renamed else {
                    throw PuppetVerbRefusal(
                        409, "the rename did not land: the note is closing or the store refused it")
                }
                return ["noteId": noteId]
            }
        ]
        if findVisible {
            verbs += [
                // An empty or missing query is the clear button's: a required argument
                // has to be a non-empty string.
                PuppetVerbs.Verb(
                    "SetFindQuery", optional: ["query"],
                    controls: ["editor.find.queryHint", "editor.find.clearQuery"]
                ) { arguments in
                    let query = (arguments["query"] as? String) ?? ""
                    findQuery = query
                    EditorHost.shared.setFindQuery(query)
                    return ["query": query]
                },
                PuppetVerbs.Verb(
                    "StepFind", required: ["direction"], integers: ["direction"],
                    controls: ["editor.find.previousMatch", "editor.find.nextMatch"]
                ) {
                    arguments in
                    let direction = (arguments["direction"] as? NSNumber)?.intValue ?? 0
                    guard direction == 1 || direction == -1 else {
                        throw PuppetVerbRefusal(400, "direction is 1 (next) or -1 (previous)")
                    }
                    EditorHost.shared.stepFind(direction)
                    return ["direction": direction]
                },
                PuppetVerbs.Verb("CloseFind", controls: ["editor.find.close"]) {
                    dismissFind()
                },
            ]
        }
        return verbs
    }
}
