import SwiftUI

/// Brand palette for FUTO Notes.
/// Primary orange, danger red, and light/dark backgrounds/surfaces.
enum Theme {
    /// Adaptive primary orange: light #F26B1F, dark #FF7A33.
    static let primary = Color.adaptive(
        light: Color(hex: 0xF26B1F),
        dark: Color(hex: 0xFF7A33)
    )

    /// Danger red #DC2626.
    static let danger = Color(hex: 0xDC2626)

    /// App background: light #FCFCFC, dark #1A1A1A.
    static let background = Color.adaptive(
        light: Color(hex: 0xFCFCFC),
        dark: Color(hex: 0x1A1A1A)
    )

    /// Surface (cards, grouped rows): light #F2F2F2, dark #171717.
    static let surface = Color.adaptive(
        light: Color(hex: 0xF2F2F2),
        dark: Color(hex: 0x171717)
    )

    /// The License plate's one remaining colour of its own.
    ///
    /// Everything else it used to carry — a gunmetal gradient, its own ink,
    /// dim ink and hairline — went out 2026-09-18 with the desktop plate's
    /// second round: the card sits on the ordinary Settings surface and reads
    /// the app's own text colours, because a slab of its own material read as a
    /// foreign object in the sheet. Gold stays because the app has no token for
    /// it.
    ///
    /// Nothing here is animated: a theme-dependent colour that repaints at its
    /// own pace is exactly what `just check-theme-single-pace` exists to stop.
    enum Plate {
        /// Gold: the eyebrow, the status chip's border, and the text buttons.
        /// Never the filled button, which keeps the app orange.
        static let accent = Color.adaptive(
            light: Color(hex: 0xB8860B),
            dark: Color(hex: 0xFFBB00)
        )
    }
}

extension Color {
    /// Build a Color from a 24-bit hex literal, e.g. 0xF26B1F.
    init(hex: UInt32, alpha: Double = 1.0) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }

    /// A color that resolves differently for light and dark UI styles.
    static func adaptive(light: Color, dark: Color) -> Color {
        Color(
            uiColor: UIColor { traits in
                traits.userInterfaceStyle == .dark
                    ? UIColor(dark)
                    : UIColor(light)
            })
    }
}

enum ThemeMode: String, CaseIterable {
    case light
    case dark
    case auto

    static let storageKey = "futo.themeMode"

    static func resolve(_ rawValue: String) -> ThemeMode {
        ThemeMode(rawValue: rawValue) ?? .auto
    }

    var interfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .light: return .light
        case .dark: return .dark
        case .auto: return .unspecified
        }
    }
}

extension View {
    func appearanceOverride(_ mode: ThemeMode) -> some View {
        onChange(of: mode, initial: true) { _, newMode in
            for scene in UIApplication.shared.connectedScenes {
                guard let windowScene = scene as? UIWindowScene else { continue }
                for window in windowScene.windows {
                    window.overrideUserInterfaceStyle = newMode.interfaceStyle
                }
            }
        }
    }
}
