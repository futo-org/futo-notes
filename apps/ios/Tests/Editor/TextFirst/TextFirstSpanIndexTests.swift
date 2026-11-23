#if DEBUG
    import Foundation
    import Testing

    @testable import FutoNotesNative

    @Suite
    struct TextFirstSpanIndexTests {
        /// The index hands a cell the same runs a scan of every span would, nested and
        /// overlapping spans and spans the cell does not touch included.
        @Test func aCellReadsTheSameRunsAsAScanOfEverySpan() {
            var seed: UInt64 = 7
            func next(_ below: Int) -> Int {
                seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
                return Int(seed >> 33) % below
            }
            var specs: [EditorStyleSpan] = []
            for _ in 0..<300 {
                let start = UInt64(next(400))
                let end = start + UInt64(next(60))
                switch next(4) {
                case 0:
                    specs.append(
                        .inline(
                            start: start, end: end, bold: next(2) == 0, italic: false,
                            strike: false, code: false))
                case 1: specs.append(.link(start: start, end: end, destination: "u\(next(9))"))
                case 2: specs.append(.wikilink(start: start, end: end, label: "l", noteId: nil))
                default: specs.append(.heading(start: start, end: end, level: 1))
                }
            }
            let index = TextFirstSpanIndex(specs)
            for _ in 0..<500 {
                let origin = next(420)
                let length = next(40)
                let scanned = TextFirstTableMetrics.runs(
                    from: specs, origin: origin, length: length)
                let indexed = TextFirstTableMetrics.runs(
                    from: index, origin: origin, length: length)
                #expect(
                    scanned.map { "\($0.range)\($0.bold)\(String(describing: $0.link))" }
                        == indexed.map { "\($0.range)\($0.bold)\(String(describing: $0.link))" },
                    "\(origin)+\(length)")
            }
        }
    }
#endif
