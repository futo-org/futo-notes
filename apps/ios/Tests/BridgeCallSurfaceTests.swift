import Foundation
import Testing

/// Anchors `Bundle(for:)` to the test bundle (see ServerUrlConformanceTests).
private final class BundleToken {}

/// Guards the host → editor call surface. `EditorWebView.swift` calls
/// `window.FutoEditor.<name>` as free-floating strings inside `evaluateJavaScript`,
/// with no compiler check that each name is a real method of the bridge
/// contract. This is a SOURCE SCAN (the same shape as Android's
/// `BridgeCoverageTest`): it bundles `EditorWebView.swift` as a resource,
/// extracts every `FutoEditor.<name>` occurrence, and asserts each is in the
/// documented set — catching a typo or an undocumented method reaching the bridge.
@Suite("Host→editor bridge call-surface")
struct BridgeCallSurfaceTests {
  /// The `window.FutoEditor` surface, mirroring `FutoEditorApi` in
  /// packages/editor/src/bridge.ts (the contract source of truth). Update both
  /// together: a method added here without a bridge.ts counterpart is not a
  /// real contract member.
  static let documentedMethods: Set<String> = [
    "setContent", "getContent", "focus", "setTheme", "setNotes",
    "applyExternalContent", "insertImage", "setImageBaseUrl",
    "exec", "blur", "setNativeToolbar",
  ]

  private static func editorSource() -> String? {
    // Bundled as .txt by a post-compile copy in project.yml — Xcode's resource
    // phase refuses to copy .swift files into a bundle.
    let bundle = Bundle(for: BundleToken.self)
    guard let url = bundle.url(forResource: "EditorWebView", withExtension: "txt"),
      let text = try? String(contentsOf: url, encoding: .utf8)
    else { return nil }
    return text
  }

  private static func calledMethods() -> Set<String> {
    guard let source = editorSource() else { return [] }
    let regex = try! NSRegularExpression(pattern: "FutoEditor\\.([A-Za-z]+)")
    let range = NSRange(source.startIndex..., in: source)
    var names: Set<String> = []
    for match in regex.matches(in: source, range: range) {
      if let captured = Range(match.range(at: 1), in: source) {
        names.insert(String(source[captured]))
      }
    }
    return names
  }

  @Test("EditorWebView.swift source is bundled and the scan sees real calls")
  func sourceIsScannable() {
    #expect(Self.editorSource() != nil)
    // A silently-empty scan would let the subset check below pass vacuously,
    // so require a known-present call.
    #expect(Self.calledMethods().contains("setContent"))
  }

  @Test("every FutoEditor.* call is a documented bridge method")
  func everyCallIsDocumented() {
    let undocumented = Self.calledMethods().subtracting(Self.documentedMethods)
    #expect(
      undocumented.isEmpty,
      "EditorWebView.swift calls FutoEditor method(s) not in the bridge contract: \(undocumented.sorted()) — add them to FutoEditorApi in bridge.ts and to documentedMethods, or fix the typo.")
  }

  @Test("documented set matches the 11-method FutoEditorApi contract")
  func documentedSetMatchesContract() {
    #expect(Self.documentedMethods.count == 11)
  }
}
