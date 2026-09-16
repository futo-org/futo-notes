import Foundation

/// The things the hosted wizard needs from the shell, because Rust cannot do
/// them: put a URL in the platform auth sheet, take that sheet down, put a
/// recovery key on the pasteboard, and say what this device is called.
/// Everything else the wizard does is a step on the Rust state machine (ADR
/// 0003, decision 11).
///
/// `announce` is how the wizard says something happened without owning a piece
/// of chrome — today the app's transient banner.
///
/// `deviceName` is what the pairing code carries and what the other device's
/// confirmation sheet names. The engine has no way to know it, and neither does
/// a view — only UIKit does.
@MainActor
protocol HostedSetupShell: AnyObject {
    var deviceName: String { get }
    func openAuthSheet(_ url: URL, onDismiss: @escaping () -> Void)
    func closeAuthSheet()
    func copyToPasteboard(_ text: String)
    func announce(_ message: LocalizedMessage)
}
