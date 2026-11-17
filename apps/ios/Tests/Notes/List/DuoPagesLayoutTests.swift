import SwiftUI
import Testing

@testable import FutoNotesNative

/// Which shell each iPhone window gets. The Duo's four windows are the reason the rule
/// exists; every ordinary iPhone, upright or sideways, must stay a phone stack.
@Suite("Duo pages layout")
struct DuoPagesLayoutTests {
    @Test(
        "each window picks its shell",
        arguments: [
            (CGSize(width: 466, height: 678), ShellLayout.stack),  // Duo closed, upright
            (CGSize(width: 678, height: 466), .pages),  // Duo closed, landscape: mini pair
            (CGSize(width: 669, height: 951), .pages),  // Duo open, tall
            (CGSize(width: 951, height: 669), .pages),  // Duo open, book
            (CGSize(width: 956, height: 440), .stack),  // Pro Max, landscape
            (CGSize(width: 667, height: 375), .stack),  // SE, landscape
            (CGSize(width: 402, height: 874), .stack),  // 17 Pro, upright
        ])
    func shellPerWindow(size: CGSize, expected: ShellLayout) {
        #expect(ShellLayout(size: size, idiom: .phone) == expected)
    }

    @Test("an iPad keeps the stack at any size")
    func iPadKeepsStack() {
        #expect(ShellLayout(size: CGSize(width: 1180, height: 820), idiom: .pad) == .stack)
    }

    @Test("only the closed Duo held upright is the outer-screen stack")
    func duoOuter() {
        #expect(ShellLayout.isDuoOuter(size: CGSize(width: 466, height: 678), idiom: .phone))
        #expect(!ShellLayout.isDuoOuter(size: CGSize(width: 402, height: 874), idiom: .phone))
        #expect(!ShellLayout.isDuoOuter(size: CGSize(width: 375, height: 667), idiom: .phone))
    }

    @Test("the pages shell follows orientation and the hinge")
    func pagesMode() {
        let book = CGSize(width: 951, height: 669)
        let tall = CGSize(width: 669, height: 951)
        #expect(PagesMode(window: book, hingeIsFlat: true) == .book)
        #expect(PagesMode(window: book, hingeIsFlat: false) == .book)
        #expect(PagesMode(window: tall, hingeIsFlat: true) == .tall)
        #expect(PagesMode(window: tall, hingeIsFlat: false) == .tabletop)
        #expect(PagesMode(window: CGSize(width: 678, height: 466), hingeIsFlat: true) == .mini)
    }

    @Test("panes split at the hinge, and a half-folded hinge gets a gutter")
    func framesFollowTheHinge() {
        let size = CGSize(width: 951, height: 669)
        let hinge = CGPoint(x: 475.5, y: 334.5)
        let flat = PagesFrames(
            mode: .book, size: size, hinge: hinge, hingeIsFlat: true, hairline: 1)
        #expect(flat.list.maxX == 475.5)
        #expect(flat.editor.minX == 476.5)
        let folded = PagesFrames(
            mode: .book, size: size, hinge: hinge, hingeIsFlat: false, hairline: 1)
        #expect(folded.seam == CGRect(x: 467.5, y: 0, width: 16, height: 669))
        #expect(folded.editor.minX == 483.5)

        let tall = CGSize(width: 669, height: 951)
        let tabletop = PagesFrames(
            mode: .tabletop, size: tall, hinge: CGPoint(x: 334.5, y: 475.5), hingeIsFlat: false,
            hairline: 1)
        #expect(tabletop.editor == CGRect(x: 0, y: 0, width: 669, height: 467.5))
        #expect(tabletop.folders.isEmpty)
    }

    @Test("the phone's path reads as the list's folder and the editor's notes")
    func pathSplits() {
        let path: [Route] = [.folder("Travel"), .folder("Travel/Lisbon"), .note("a"), .note("b")]
        #expect(PagesPath.folder(of: path) == "Travel/Lisbon")
        #expect(PagesPath.notes(of: path) == [.note("a"), .note("b")])
        #expect(PagesPath.chain("Travel/Lisbon") == [.folder("Travel"), .folder("Travel/Lisbon")])
        // A folder pushed over an open note (the puppet's OpenFolder) closes it, as on the phone.
        #expect(PagesPath.notes(of: [.note("a"), .folder("Work")]).isEmpty)
        #expect(PagesPath.folder(of: [.note("a")]).isEmpty)
    }
}
