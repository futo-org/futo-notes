import SwiftUI

/// The Settings and Sync sheets and the license landing, shared by every shell
/// (the phone stack and the Duo's pages) so they reach them the same way.
struct AppSheets: ViewModifier {
    @EnvironmentObject private var store: NotesStore
    @EnvironmentObject private var sync: SyncManager
    /// Only to hand on to the Settings sheet, which owns the License row.
    /// Every object Settings reads is re-injected: a sheet that lost one
    /// crashed on iPad (crash #1839).
    @EnvironmentObject private var license: LicenseModel
    @EnvironmentObject private var licenseStorefront: LicenseStorefront
    @EnvironmentObject private var navigation: AppNavigation

    /// Whether any UIKit-level modal (a sheet or cover from this list, a
    /// folder row, the crash report) is already over the root. SwiftUI drops a
    /// presentation made while another is up, so the landing asks first.
    private static var modalIsPresented: Bool {
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .contains { $0.rootViewController?.presentedViewController != nil }
    }

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: navigation.isPresenting(.sync)) {
                SyncView()
                    .environmentObject(sync)
                    .environmentObject(store)
            }
            // An activation that includes the app icon lands on the picker over
            // Settings. The landing is decided at activation time and never
            // kept: SettingsView takes it when it is already up; otherwise it is
            // presented here only if nothing else covers the list (a stray
            // flag would pop the picker, header and all, on a later manual
            // open). Skipped when the OS cannot change icons.
            .onChange(of: license.pendingLanding, initial: true) { _, pending in
                guard pending, !navigation.isPresenting(.settings).wrappedValue else { return }
                guard UIApplication.shared.supportsAlternateIcons, !Self.modalIsPresented else {
                    license.consumeLanding()
                    return
                }
                navigation.sheet = .settings
            }
            // Backstop: whatever happened, closing Settings leaves no landing behind.
            .onChange(of: navigation.sheet) {
                if !navigation.isPresenting(.settings).wrappedValue { license.consumeLanding() }
            }
            .sheet(isPresented: navigation.isPresenting(.settings)) {
                SettingsView()
                    .environmentObject(sync)
                    .environmentObject(store)
                    .environmentObject(license)
                    .environmentObject(licenseStorefront)
                    .environmentObject(navigation)
            }
    }
}

extension View {
    func appSheets() -> some View { modifier(AppSheets()) }
}
