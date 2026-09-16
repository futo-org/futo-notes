import Foundation

/// The three things the hosted wizard needs from the shell, because Rust
/// cannot do them: put a URL in the platform auth sheet, take that sheet down,
/// and put a recovery key on the pasteboard. Everything else the wizard does is
/// a step on the Rust state machine (ADR 0003, decision 11).
///
/// `announce` is how the wizard says something happened without owning a piece
/// of chrome — today the app's transient banner.
@MainActor
protocol HostedSetupShell: AnyObject {
    func openAuthSheet(_ url: URL, onDismiss: @escaping () -> Void)
    func closeAuthSheet()
    func copyToPasteboard(_ text: String)
    func announce(_ message: LocalizedMessage)
}
