#if DEBUG
    import Foundation

    extension PuppetServerContract {
        /// The platform `unsupported` refusals name.
        static let platform = "ios"

        /// Verbs the verb map (.claude/skills/puppet/references/commands/verb-map.md) names on
        /// another platform that iOS does not offer, each with what does the job here. A known
        /// verb answers 501 with `unsupported: true` instead of the 404 an unknown name gets, so
        /// a driver stops instead of retrying other spellings.
        static let unsupportedVerbs: [String: String] = {
            let realType =
                #"real typing is `type '{"text":"…"}'` into the focused editor; a direct edit is `do Insert` or `do Replace`"#
            let realKey =
                #"a real key is `press '{"key":"Enter"}'`; Undo, Redo and the toolbar's commands are their own verbs, and Select All is `do SelectAll`"#
            let insert =
                #"write it with `do Insert '{"after":"…","text":"…"}'` (or `before`, `at`)"#
            let tableMenu = "the iOS editor has no table row or column menus"
            let systemMenu =
                "this menu is iOS's own: `tap` its button (a row's: `tap {\"ref\":…,\"hold\":0.8}`), then `tap` the item `elements` lists"
            let linkPrompt =
                "`do Link` opens iOS's link prompt, a system alert: fill it with real `tap` and `type`"
            return [
                "Type": realType,
                "Press": realKey,
                "AppendLine": insert,
                "InsertLine": insert,
                "MoveBlock": "the iOS editor has no block drag handle",
                "InsertImage": "`tap` the toolbar's image button, which opens the system picker",
                "LinkSelection": "the iOS editor has no floating selection toolbar: `do Link`",
                "PickSlashItem": "the iOS editor has no slash menu",
                "PickLinkSuggestion":
                    #"accept a suggestion with `do AcceptSuggestion '{"index":0}'` or a `tap` on it"#,
                "SetLinkUrl": linkPrompt, "ApplyLink": linkPrompt, "CancelLink": linkPrompt,
                "SetLinkLabel": linkPrompt, "SetLinkDestination": linkPrompt,
                "SubmitLink": linkPrompt, "RemoveLink": linkPrompt, "DismissLink": linkPrompt,
                "FocusEditor": "`tap` the note body, as a person does",
                "BlurEditor": "`tap` the toolbar's Dismiss keyboard button",
                "AcceptWikilinkCompletion":
                    #"accept a suggestion with `do AcceptSuggestion '{"index":0}'` or a `tap` on it"#,
                "DismissWikilinkCompletion": "`tap` the suggestions' Close button",
                "FinishTableCell":
                    "the iOS cell editor has no Done: `tap` the note outside the table",
                "Code":
                    "the iOS toolbar has no inline code item: `do CodeBlock` makes a code block",
                "Paragraph":
                    "the iOS toolbar has no Paragraph item: toggle a heading off with its own Heading verb",
                "OpenTableRowMenu": tableMenu, "OpenTableColumnMenu": tableMenu,
                "InsertRowAbove": tableMenu, "InsertRowBelow": tableMenu, "DeleteRow": tableMenu,
                "InsertColumnLeft": tableMenu, "InsertColumnRight": tableMenu,
                "DeleteColumn": tableMenu,
                "ToggleNoteActionsMenu": systemMenu, "OpenNoteContextMenu": systemMenu,
                "OpenFolderContextMenu": systemMenu, "CloseContextMenu": systemMenu,
                "ToggleSortMenu": systemMenu, "SetSortOrder": systemMenu,
            ]
        }()

        /// The 501 for a verb another platform has and iOS does not; nil for any other name.
        static func unsupportedRefusal(_ verb: String) -> PuppetReply? {
            guard let instead = unsupportedVerbs[verb] else { return nil }
            return (
                501,
                json([
                    "ok": false, "unsupported": true, "platform": platform, "verb": verb,
                    "error": "\(verb) is not supported on this platform (iOS): \(instead)",
                ])
            )
        }
    }
#endif
