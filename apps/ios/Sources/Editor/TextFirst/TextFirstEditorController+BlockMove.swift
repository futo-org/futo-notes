import UIKit

// Block movement (#311): the engine says which lines a line lifts, where they may land, and
// moves them as one Undo step. The view only names display positions, as UTF-16 offsets here
// and display bytes to the engine. Puppet's `MoveBlock` drives this.

extension TextFirstEditorController {
    /// The UTF-16 display range of the block the line at UTF-16 `offset` lifts (from its first
    /// line's start to the start of the line after it); nil when it lifts nothing.
    func blockRange(atLineOffset offset: Int) throws -> NSRange? {
        let at = EditorDisplayByteOffset(offset: try mirror.utf16ToByte(unit: UInt64(offset)))
        guard let block = try session.blockAt(expected: rev, at: at) else { return nil }
        let start = Int(try mirror.byteToUtf16(byte: block.start))
        return NSRange(
            location: start, length: Int(try mirror.byteToUtf16(byte: block.end)) - start)
    }

    /// Where the block the line at UTF-16 `offset` lifts may land, as UTF-16 offsets of the line
    /// starts below each slot (the text's end for the note's end); nil when it lifts nothing.
    func blockSlots(atLineOffset offset: Int) throws -> [Int]? {
        let at = EditorDisplayByteOffset(offset: try mirror.utf16ToByte(unit: UInt64(offset)))
        guard try session.blockAt(expected: rev, at: at) != nil else { return nil }
        return try session.blockSlots(expected: rev, at: at).map {
            Int(try mirror.byteToUtf16(byte: $0.offset))
        }
    }

    /// Move the block the line at UTF-16 `offset` lifts to its slot at UTF-16 `slot`. False
    /// when the editor is closed or busy, or the engine refuses (no block, not a slot, or a
    /// move that would change what a line reads as); the note is then unchanged.
    func moveBlock(atLineOffset offset: Int, toSlot slot: Int) throws -> Bool {
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
