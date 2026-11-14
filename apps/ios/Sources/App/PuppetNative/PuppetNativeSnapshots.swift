#if DEBUG
    import Foundation

    extension PuppetNativeEditor {
        struct Snapshot {
            let id: Int
            let rows: [[String: Any]]
            let selection: [String: Int]?
            let revision: UInt64?
            let title: String?
            var source: String? = nil
            var fullyVisibleLines: Set<Int> = []
        }
        func snapshot() -> Snapshot {
            snapshotId += 1
            guard let c = controller, !c.closed else {
                return Snapshot(id: snapshotId, rows: [], selection: nil, revision: nil, title: nil)
            }
            let selected = c.effectiveSelection
            let document = Document(c)
            return Snapshot(
                id: snapshotId, rows: document.rows(),
                selection: ["from": selected.location, "to": NSMaxRange(selected)],
                revision: Self.version(c), title: state(note: c.noteId)["title"] as? String,
                source: c.engineBusy ? nil : try? c.session.sourceText(),
                fullyVisibleLines: Set(
                    document.shown.filter {
                        $0.range.location >= document.visible.location
                            && NSMaxRange($0.range) <= NSMaxRange(document.visible)
                    }.map(\.number)))
        }
        func diff(_ before: Snapshot, _ after: Snapshot) -> [String: Any] {
            var result: [String: Any] = [
                "before": before.id, "after": after.id,
                "elements": ["added": [Any](), "removed": [Any](), "changed": [Any]()],
            ]
            if before.selection != after.selection {
                result["selection"] = [
                    before.selection as Any? ?? NSNull(), after.selection as Any? ?? NSNull(),
                ]
            }
            if before.title != after.title {
                result["state"] = [
                    "editor.title":
                        [before.title as Any? ?? NSNull(), after.title as Any? ?? NSNull()]
                ]
            }
            // Source is a pure engine read captured only for tool requests. Viewport movement
            // cannot create edits; only the canonical before/after strings determine the hunk.
            if let oldSource = before.source, let newSource = after.source, oldSource != newSource {
                let old = Array(oldSource)
                let new = Array(newSource)
                var prefix = 0
                while prefix < min(old.count, new.count), old[prefix] == new[prefix] { prefix += 1 }
                var suffix = 0
                while suffix < min(old.count, new.count) - prefix,
                    old[old.count - suffix - 1] == new[new.count - suffix - 1]
                { suffix += 1 }
                let removed = String(old[prefix..<(old.count - suffix)])
                let inserted = String(new[prefix..<(new.count - suffix)])
                let line = old[..<prefix].filter { $0 == "\n" }.count + 1
                func visible(_ snapshot: Snapshot, _ text: String) -> Bool {
                    // A logical line may wrap across many screens. Line presence alone never
                    // proves its canonical source text is entirely on screen.
                    let numbers = snapshot.fullyVisibleLines
                    let end = line + text.filter { $0 == "\n" }.count
                    return (line...end).allSatisfy { numbers.contains($0) }
                }
                if visible(before, removed), visible(after, inserted) {
                    result["doc"] = ["line": line, "removed": removed, "inserted": inserted]
                } else {
                    func partial(_ snapshot: Snapshot, _ text: String) -> Bool {
                        let present = Set(snapshot.rows.compactMap { $0["line"] as? Int })
                        let end = line + text.filter { $0 == "\n" }.count
                        return (line...end).contains {
                            present.contains($0) && !snapshot.fullyVisibleLines.contains($0)
                        }
                    }
                    result["doc"] = [
                        "line": line, "offscreen": true,
                        "partial": partial(before, removed) || partial(after, inserted),
                        "removedLines": removed.isEmpty
                            ? 0 : removed.filter { $0 == "\n" }.count + 1,
                        "insertedLines": inserted.isEmpty
                            ? 0 : inserted.filter { $0 == "\n" }.count + 1,
                    ]
                }
            }
            return result
        }
    }
#endif
