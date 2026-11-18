#if DEBUG
    import UIKit

    extension PuppetNativeEditor {
        /// `MoveBlock {line, column?, before | after}`: what a press at UTF-16 `column` of line
        /// `line` lifts (its start by default; on screen, as a hand picks it up) dropped at the
        /// boundary above `before` or below `after` (anywhere in the note). An image sharing its
        /// line lifts alone when the column is on it. Lines are the display's, as every iOS verb
        /// counts them. The engine decides the block and its slots; a boundary that is not one
        /// of them is a 409.
        func moveBlock(
            _ args: [String: Any], _ document: Document, _ c: TextFirstEditorController
        ) throws -> [String: Any] {
            guard let number = args["line"] as? Int else {
                throw PuppetVerbRefusal(400, "MoveBlock requires line")
            }
            let before = args["before"] as? Int
            let after = args["after"] as? Int
            guard (before == nil) != (after == nil) else {
                throw PuppetVerbRefusal(
                    400, #"MoveBlock needs one of {"before":<line>} or {"after":<line>}"#)
            }
            let line = try document.requireLine(number)
            // Only an omitted column is the line's start; anything supplied must be a whole
            // number on the line (JSON hands a boolean over as a number, so it is ruled out).
            var column = 0
            if let raw = args["column"] {
                let boolean = CFGetTypeID(raw as CFTypeRef) == CFBooleanGetTypeID()
                guard let value = raw as? Int, !boolean, (0...line.range.length) ~= value
                else {
                    throw PuppetVerbRefusal(
                        400, "column \(raw) is not a UTF-16 column on line \(number)")
                }
                column = value
            }
            let at = line.range.location + column
            // Above a line is its start; below the last line is the note's end, which an empty
            // last line (an empty task shows no characters) shares with the boundary above it.
            let target = try document.requireLine(before ?? after!, visibleOnly: false)
            let slot: TextFirstBlockSlot
            if before != nil {
                slot = TextFirstBlockSlot(offset: target.range.location, end: false)
            } else if target.number < document.lines.count {
                slot = TextFirstBlockSlot(
                    offset: document.lines[target.number].range.location, end: false)
            } else {
                slot = TextFirstBlockSlot(offset: document.text.length, end: true)
            }
            let side = before != nil ? "before" : "after"
            guard let slots = try c.blockSlots(at: at) else {
                throw PuppetVerbRefusal(
                    409,
                    "line \(number) lifts nothing: a blank line, front matter and code nothing closes do not move"
                )
            }
            guard slots.contains(slot) else {
                throw PuppetVerbRefusal(
                    409,
                    "line \(number)'s block cannot land \(side) line \(target.number): that boundary is its own edge, or inside a quote, code block, table or front matter, or inside a list that takes only list items and plain lines, or a line would read as another kind of block there"
                )
            }
            guard try c.moveBlock(at: at, to: slot) else {
                throw PuppetVerbRefusal(
                    409,
                    "the editor refused to move line \(number)'s block \(side) line \(target.number): the note changed, or the editor was busy"
                )
            }
            return ["moved": ["line": number, side: target.number]]
        }
    }
#endif
