import SwiftUI
import Testing
import UIKit

@testable import FutoNotesNative

/// The inline title field must be exactly as wide as the slot it is given, so
/// a long title cannot drag the editor off-screen (list.md). A UITextField's
/// natural width grows with its text, so this is not the default.
@MainActor
@Suite("Inline title field layout")
struct TitleTextFieldLayoutTests {
    /// Points across an iPhone 17 Pro, the width the editor proposes to the field.
    private static let proposedWidth: CGFloat = 402

    private static let longTitle =
        "A very long note title that keeps going and going well past the width of an iPhone screen"

    private func hosted(_ title: String) -> UIHostingController<TitleTextField> {
        UIHostingController(rootView: TitleTextField(text: .constant(title), onChange: { _ in }))
    }

    private func measuredWidth(title: String) -> CGFloat {
        hosted(title).sizeThatFits(
            in: CGSize(width: Self.proposedWidth, height: .greatestFiniteMagnitude)
        ).width
    }

    @Test("a title far wider than the screen never exceeds the proposed width")
    func longTitleStaysWithinProposedWidth() {
        #expect(measuredWidth(title: Self.longTitle) <= Self.proposedWidth)
    }

    @Test("a short title fills the proposed width instead of hugging its text")
    func shortTitleFillsProposedWidth() {
        #expect(measuredWidth(title: "todo") == Self.proposedWidth)
    }

    /// An unspecified proposal asks for the ideal size rather than offering a
    /// slot, so the natural text width is the correct answer there — the clamp
    /// applies to real layout slots only.
    @Test("an unspecified proposal still reports the title's natural width")
    func unspecifiedProposalReportsNaturalWidth() {
        let ideal = hosted(Self.longTitle).sizeThatFits(in: UIView.layoutFittingExpandedSize)
        #expect(ideal.width > Self.proposedWidth)
    }
}
