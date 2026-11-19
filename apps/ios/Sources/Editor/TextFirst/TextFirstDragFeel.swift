import UIKit

/// How a press lifts a block: the old web editor's hold and tolerance.
enum TextFirstLiftPolicy {
    /// How long a press holds before it lifts.
    static let holdDuration: TimeInterval = 0.34
    /// How far, in points, the finger may wander while it holds.
    static let movementTolerance: CGFloat = 10
}

/// The drag's feel, as the web editor's iOS host gave it: an impact at the lift, a selection
/// tick each time the drop line reaches a new slot, and a lighter impact when the block lands.
/// A card that returns lands nothing and is silent.
@MainActor
final class TextFirstDragHaptics {
    private let lift = UIImpactFeedbackGenerator(style: .medium)
    private let tick = UISelectionFeedbackGenerator()
    private let drop = UIImpactFeedbackGenerator(style: .light)

    /// A press that may lift has begun: have the lift's impact ready when the hold ends.
    func prepareLift() { lift.prepare() }
    func lifted() {
        lift.impactOccurred()
        tick.prepare()
        drop.prepare()
    }
    #if DEBUG
        /// The ticks given so far (a debug build reports them).
        private(set) var ticks = 0
    #endif
    func reachedSlot() {
        #if DEBUG
            ticks += 1
        #endif
        tick.selectionChanged()
        tick.prepare()
    }
    func landed() { drop.impactOccurred() }
}
