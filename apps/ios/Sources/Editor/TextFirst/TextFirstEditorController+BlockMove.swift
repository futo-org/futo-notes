import UIKit

// Block movement (#311): the engine says what a press at a display position lifts (an image
// that shares its line, alone; else the lines its line lifts), where it may land, and moves it
// as one Undo step. The view only names display positions, as UTF-16 offsets here and display
// bytes to the engine. Puppet's `MoveBlock` drives this.

/// A boundary between lines a block may land on: above the line starting at UTF-16 `offset`, or,
/// when `end`, below the note's last line (`offset` is then the text's end). Around a last line
/// that shows no characters (an empty task) the two share `offset`; `end` tells them apart.
struct TextFirstBlockSlot: Hashable {
    let offset: Int
    let end: Bool
}

/// What a press lifts: its UTF-16 range, and whether its bottom edge is the note's end (below the
/// last line) rather than the start of the line after it.
struct TextFirstLiftedBlock: Equatable {
    let range: NSRange
    let toEnd: Bool
}

extension TextFirstEditorController {
    /// What a press at UTF-16 `offset` lifts: an image there that lifts alone, else its line's
    /// block from its first line's start to the start of the line after it or the note's end;
    /// nil when it lifts nothing.
    func liftedBlock(at offset: Int) throws -> TextFirstLiftedBlock? {
        let at = EditorDisplayByteOffset(offset: try mirror.utf16ToByte(unit: UInt64(offset)))
        guard let block = try session.blockAt(expected: rev, at: at) else { return nil }
        let ends = try mirror.bytesToUtf16(bytes: [block.range.start, block.range.end])
        let start = Int(ends[0])
        return TextFirstLiftedBlock(
            range: NSRange(location: start, length: Int(ends[1]) - start), toEnd: block.toEnd)
    }

    /// Where what a press at UTF-16 `offset` lifts may land among the boundaries inside UTF-16
    /// `within` (the whole note when nil), in order; nil when it lifts nothing. One engine call
    /// and one conversion, however many slots: a lift asks only for what is near the screen.
    func blockSlots(at offset: Int, within: NSRange? = nil) throws -> [TextFirstBlockSlot]? {
        let at = EditorDisplayByteOffset(offset: try mirror.utf16ToByte(unit: UInt64(offset)))
        guard try session.blockAt(expected: rev, at: at) != nil else { return nil }
        let range = within ?? NSRange(location: 0, length: storage.length)
        let bytes = try mirror.displayBytes(range)
        let slots = try session.blockSlots(expected: rev, at: at, within: bytes)
        let offsets = try mirror.bytesToUtf16(bytes: slots.map(\.offset))
        return zip(slots, offsets).map { TextFirstBlockSlot(offset: Int($1), end: $0.end) }
    }

    /// Move what a press at UTF-16 `offset` lifts to its slot `slot`. False when the editor is
    /// closed or busy, or the engine refuses (no block, or not one of its slots); the note is
    /// then unchanged.
    func moveBlock(at offset: Int, to slot: TextFirstBlockSlot) throws -> Bool {
        guard !closed, !engineBusy else { return false }
        finishComposition()
        let at = EditorDisplayByteOffset(offset: try mirror.utf16ToByte(unit: UInt64(offset)))
        let to = EditorBlockBoundary(
            offset: try mirror.utf16ToByte(unit: UInt64(slot.offset)), end: slot.end)
        guard let change = try session.moveBlock(expected: rev, at: at, to: to) else {
            return false
        }
        try accept(change)
        return true
    }
}

extension EditorDisplayMirror {
    /// UTF-16 `range` as display bytes.
    fileprivate func displayBytes(_ range: NSRange) throws -> EditorByteRange {
        EditorByteRange(
            start: try utf16ToByte(unit: UInt64(range.location)),
            end: try utf16ToByte(unit: UInt64(NSMaxRange(range))))
    }
}
