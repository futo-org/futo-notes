import Testing

@testable import FutoNotesNative

/// The generated live title filter must forbid exactly the canonical C0/DEL/C1
/// control ranges — not Foundation's `.controlCharacters`, which also holds the
/// Cf format characters (the U+200D joiner inside the family and rainbow-flag emoji).
@Suite("Generated title filter")
struct TitleSpecTests {
    @Test("the C0, DEL and C1 range edges are forbidden")
    func controlRangeEdgesAreForbidden() {
        for scalar: Unicode.Scalar in ["\u{00}", "\u{1F}", "\u{7F}", "\u{9F}"] {
            #expect(TitleSpec.forbiddenScalars.contains(scalar))
        }
    }

    @Test("format characters outside those ranges are allowed")
    func formatCharactersAreAllowed() {
        for scalar: Unicode.Scalar in [
            "\u{20}", "\u{A0}", "\u{AD}", "\u{200D}", "\u{200E}", "\u{2066}",
        ] {
            #expect(!TitleSpec.forbiddenScalars.contains(scalar))
        }
    }
}
