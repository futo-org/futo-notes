import UIKit

// Block movement (#311): the engine says what a press at a display position lifts (an image
// that shares its line, alone; else the lines its line lifts), where it may land, and moves it
// as one Undo step. The view only names display positions, as UTF-16 offsets here and display
// bytes to the engine. Puppet's `MoveBlock` drives this.

extension TextFirstEditorController {
    /// The UTF-16 display range of what a press at UTF-16 `offset` lifts: an image there that
    /// lifts alone, else its line's block from its first line's start to the start of the line
    /// after it; nil when it lifts nothing.
    func blockRange(at offset: Int) throws -> NSRange? {
        let at = EditorDisplayByteOffset(offset: try mirror.utf16ToByte(unit: UInt64(offset)))
        guard let block = try session.blockAt(expected: rev, at: at) else { return nil }
        let start = Int(try mirror.byteToUtf16(byte: block.start))
        return NSRange(
            location: start, length: Int(try mirror.byteToUtf16(byte: block.end)) - start)
    }

    /// Where what a press at UTF-16 `offset` lifts may land, as UTF-16 offsets of the line
    /// starts below each slot (the text's end for the note's end); nil when it lifts nothing.
    func blockSlots(at offset: Int) throws -> [Int]? {
        let at = EditorDisplayByteOffset(offset: try mirror.utf16ToByte(unit: UInt64(offset)))
        guard try session.blockAt(expected: rev, at: at) != nil else { return nil }
        return try session.blockSlots(expected: rev, at: at).map {
            Int(try mirror.byteToUtf16(byte: $0.offset))
        }
    }

    /// Move what a press at UTF-16 `offset` lifts to its slot at UTF-16 `slot`. False when the
    /// editor is closed or busy, or the engine refuses (no block, not a slot, or a move that
    /// would change what a line reads as); the note is then unchanged.
    func moveBlock(at offset: Int, toSlot slot: Int) throws -> Bool {
        guard !closed, !engineBusy else { return false }
        finishComposition()
        let at = EditorDisplayByteOffset(offset: try mirror.utf16ToByte(unit: UInt64(offset)))
        let to = EditorDisplayByteOffset(offset: try mirror.utf16ToByte(unit: UInt64(slot)))
        guard let change = try session.moveBlock(expected: rev, at: at, to: to) else {
            return false
        }
        try accept(change)
        return true
    }
}
