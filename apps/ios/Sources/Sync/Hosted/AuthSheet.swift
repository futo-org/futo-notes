import AuthenticationServices
import UIKit

/// The platform auth sheet. Sign-in, checkout, and the customer portal all open
/// here, over the app, rather than switching to a browser (ADR 0003, decision
/// 1; parent spec user story 2).
///
/// Nothing comes back through it. There is no URL scheme, universal link, or
/// return redirect anywhere in this flow — the app asks the server what
/// happened (`awaitSignIn`, `awaitEntitled`). So the session is created with no
/// callback scheme at all, which means the only way it completes on its own is
/// the person closing it; that is reported as `onDismiss` so the wait can be
/// cancelled and the screen left exactly where it was.
@MainActor
final class AuthSheet: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    /// Bumped by every open and every close, so a cancel we asked for cannot
    /// be mistaken for the person dismissing the sheet we opened next.
    private var generation = 0

    func open(_ url: URL, onDismiss: @escaping () -> Void) {
        close()
        generation += 1
        let opened = generation
        let session = ASWebAuthenticationSession(url: url, callbackURLScheme: nil) {
            [weak self] _, _ in
            MainActor.assumeIsolated {
                guard let self, self.generation == opened else { return }
                self.session = nil
                onDismiss()
            }
        }
        session.presentationContextProvider = self
        // Deliberately not ephemeral: an existing FUTO session in the shared
        // web credential store is what makes a second sign-in one tap (parent
        // spec user story 3).
        session.prefersEphemeralWebBrowserSession = false
        self.session = session
        session.start()
    }

    /// Takes the sheet down because the outcome already arrived.
    func close() {
        guard let session else { return }
        generation += 1
        self.session = nil
        session.cancel()
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let window =
            scenes.first(where: { $0.activationState == .foregroundActive })?.keyWindow
            ?? scenes.compactMap(\.keyWindow).first
        return window ?? ASPresentationAnchor()
    }
}
