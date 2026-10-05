import Foundation
import JavaScriptCore
import Testing

@testable import FutoNotesNative

// RC-71 follow-up: the relink adopt is "replace the page's document with the
// relinked body IF it still holds the text the shell read". The compare and the
// replace are ONE script, so a keystroke cannot land between them. These tests
// run the real script against a stand-in FutoEditor in JavaScriptCore.
@Suite("Conditional external adoption")
struct ExternalAdoptionTests {
    /// A page whose editor holds `document` and counts how often it was replaced.
    private func page(holding document: String) -> JSContext {
        let context = JSContext()!
        context.evaluateScript(
            """
            var window = { FutoEditor: {
              doc: \(jsonLiteral(document)),
              replaced: 0,
              getContent() { return this.doc; },
              applyExternalContent(text) { this.doc = text; this.replaced += 1; }
            } };
            """)
        return context
    }

    private func run(_ script: String, in context: JSContext) -> ExternalAdoption {
        guard let answer = context.evaluateScript(script)?.toString(), answer != "null" else {
            return .unavailable
        }
        return externalAdoption(from: answer)
    }

    @Test("a page that still holds the read text takes the relinked body")
    func unchangedPageIsReplaced() {
        let context = page(holding: "back to [[Old]]")
        let result = run(
            adoptIfUnchangedScript(expected: "back to [[Old]]", replacement: "back to [[New]]"),
            in: context)

        #expect(result == .applied)
        #expect(context.evaluateScript("window.FutoEditor.doc")?.toString() == "back to [[New]]")
    }

    @Test("a page that gained a keystroke keeps it and reports it")
    func typedPageIsLeftAlone() {
        let context = page(holding: "back to [[Old]]k")
        let result = run(
            adoptIfUnchangedScript(expected: "back to [[Old]]", replacement: "back to [[New]]"),
            in: context)

        #expect(result == .kept(liveText: "back to [[Old]]k"))
        #expect(context.evaluateScript("window.FutoEditor.doc")?.toString() == "back to [[Old]]k")
        #expect(context.evaluateScript("window.FutoEditor.replaced")?.toInt32() == 0)
    }

    @Test("quotes, backslashes, newlines and non-BMP text survive the script")
    func awkwardTextRoundTrips() {
        let awkward = "say \"hi\" \\ and\n\u{1F600} [[Old]]"
        let context = page(holding: "")
        context.evaluateScript("window.FutoEditor.doc = \(jsonLiteral(awkward));")
        let result = run(
            adoptIfUnchangedScript(expected: awkward, replacement: awkward + "!"), in: context)

        #expect(result == .applied)
        #expect(context.evaluateScript("window.FutoEditor.doc")?.toString() == awkward + "!")
    }

    @Test("a page with no editor decides nothing")
    func noEditorIsUnavailable() {
        let context = JSContext()!
        context.evaluateScript("var window = {};")

        #expect(
            run(adoptIfUnchangedScript(expected: "a", replacement: "b"), in: context)
                == .unavailable)
    }

    @Test("an unreadable answer decides nothing")
    func garbageIsUnavailable() {
        #expect(externalAdoption(from: "not json") == .unavailable)
        #expect(externalAdoption(from: "{\"applied\":false}") == .unavailable)
    }

    private func jsonLiteral(_ text: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [text])
        return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
    }
}
