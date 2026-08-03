import Foundation
import Testing

@testable import FutoNotesNative

@Suite("Editor WebView navigation policy")
struct EditorNavigationDecisionTests {
  @Test("allows the bundled editor file load")
  func allowsEditorFileLoad() throws {
    let url = try #require(URL(string: "file:///app/editor.html"))

    #expect(
      editorNavigationDecision(
        for: url,
        isMainFrame: true,
        permittedFileURL: url
      ) == .allow
    )
  }

  @Test("denies a different bundle file in the editor directory")
  func deniesDifferentBundleFile() throws {
    let permittedURL = try #require(URL(string: "file:///app/editor.html"))
    let otherURL = try #require(URL(string: "file:///app/other.html"))

    #expect(
      editorNavigationDecision(
        for: otherURL,
        isMainFrame: true,
        permittedFileURL: permittedURL
      ) == .deny
    )
  }

  @Test("standardizes file paths before comparing them")
  func standardizesFilePaths() throws {
    let permittedURL = try #require(URL(string: "file:///app/editor.html"))
    let editorTraversalURL = try #require(
      URL(string: "file:///app/subdir/../editor.html")
    )
    let otherTraversalURL = try #require(
      URL(string: "file:///app/subdir/../other.html")
    )

    #expect(
      editorNavigationDecision(
        for: editorTraversalURL,
        isMainFrame: true,
        permittedFileURL: permittedURL
      ) == .allow
    )
    #expect(
      editorNavigationDecision(
        for: otherTraversalURL,
        isMainFrame: true,
        permittedFileURL: permittedURL
      ) == .deny
    )
  }

  @Test("denies file loads when no editor file is permitted")
  func deniesFileLoadWithoutPermittedURL() throws {
    let url = try #require(URL(string: "file:///app/editor.html"))

    #expect(
      editorNavigationDecision(
        for: url,
        isMainFrame: true,
        permittedFileURL: nil
      ) == .deny
    )
  }

  @Test("allows about:blank for the missing-editor fallback")
  func allowsAboutBlankFallback() throws {
    let url = try #require(URL(string: "about:blank"))

    #expect(
      editorNavigationDecision(
        for: url,
        isMainFrame: true,
        permittedFileURL: nil
      ) == .allow
    )
  }

  @Test("opens HTTP and HTTPS main-frame navigations externally")
  func opensHttpAndHttpsMainFramesExternally() throws {
    let externalUrls = [
      try #require(URL(string: "http://example.com/note")),
      try #require(URL(string: "https://example.com/note")),
    ]

    for url in externalUrls {
      #expect(
        editorNavigationDecision(
          for: url,
          isMainFrame: true,
          permittedFileURL: nil
        )
          == .openExternally(url)
      )
    }
  }

  @Test("opens mail and telephone links externally")
  func opensMailAndTelephoneLinksExternally() throws {
    let externalUrls = [
      try #require(URL(string: "mailto:notes@example.com")),
      try #require(URL(string: "tel:+15551234567")),
    ]

    for url in externalUrls {
      #expect(
        editorNavigationDecision(
          for: url,
          isMainFrame: true,
          permittedFileURL: nil
        )
          == .openExternally(url)
      )
    }
  }

  @Test("denies unsafe and unknown main-frame schemes")
  func deniesUnsafeAndUnknownMainFrameSchemes() throws {
    let deniedUrls = [
      try #require(URL(string: "javascript:alert(1)")),
      try #require(URL(string: "data:text/html,away")),
      try #require(URL(string: "futo-custom://editor/away")),
    ]

    for url in deniedUrls {
      #expect(
        editorNavigationDecision(
          for: url,
          isMainFrame: true,
          permittedFileURL: nil
        ) == .deny
      )
    }
  }

  @Test("denies a main-frame navigation without a URL")
  func deniesMissingMainFrameUrl() {
    #expect(
      editorNavigationDecision(
        for: nil,
        isMainFrame: true,
        permittedFileURL: nil
      ) == .deny
    )
  }

  @Test("allows non-main-frame loads without changing existing behavior")
  func allowsNonMainFrameLoad() throws {
    let url = try #require(URL(string: "futo-asset://image.png"))

    #expect(
      editorNavigationDecision(
        for: url,
        isMainFrame: false,
        permittedFileURL: nil
      ) == .allow
    )
  }
}
