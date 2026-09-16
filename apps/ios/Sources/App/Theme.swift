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

    /// The License card's "Steel Ledger" plate: a gunmetal plate with a gold
    /// accent and a recessed circular well (docs/plan/license-ship.md D1/D5).
    ///
    /// These are the desktop plate's custom properties in Swift — the same six
    /// hex pairs, so the two platforms are one design in two languages. They
    /// live here rather than in the License view because they are palette, and
    /// because the well's two inset shadows are the same numbers the desktop
    /// `box-shadow` uses.
    ///
    /// Nothing here is animated: only desktop turns the coin (D5), and a
    /// theme-dependent colour that repaints at its own pace is exactly what
    /// `just check-theme-single-pace` exists to stop.
    enum Plate {
        /// Plate gradient, top → bottom.
        static let top = Color.adaptive(
            light: Color(hex: 0xDFE4E8),
            dark: Color(hex: 0x2A3139)
        )
        static let bottom = Color.adaptive(
            light: Color(hex: 0xCDD5DC),
            dark: Color(hex: 0x1C2228)
        )
        /// Primary text on the plate.
        static let ink = Color.adaptive(
            light: Color(hex: 0x1C2733),
            dark: Color(hex: 0xE6EBEF)
        )
        /// Row labels and the explanation paragraph.
        static let inkDim = Color.adaptive(
            light: Color(hex: 0x4F5D6A),
            dark: Color(hex: 0x9AA6B1)
        )
        /// Hairlines between the ledger rows.
        static let rule = Color.adaptive(
            light: Color(hex: 0xA9B4BE),
            dark: Color(hex: 0x3D4650)
        )
        /// Gold: the eyebrow, the status chip's border, and the text buttons.
        /// Never the filled button, which keeps the app orange.
        static let accent = Color.adaptive(
            light: Color(hex: 0xB8860B),
            dark: Color(hex: 0xFFBB00)
        )

        static let gradient = LinearGradient(
            colors: [top, bottom], startPoint: .top, endPoint: .bottom)

        /// The well's recess, matching the desktop
        /// `inset 0 2px 6px rgba(0,0,0,.28), inset 0 -1px 0 rgba(255,255,255,.35)`.
        /// Both are fixed rgba in the mock, identical in light and dark.
        static let wellShadow = Color.black.opacity(0.28)
        static let wellHighlight = Color.white.opacity(0.35)

        /// The well (and the key field) are the plate with a hole in it: the
        /// darker stop, pushed in by the two shadows above. No ring, no
        /// outline — the recess is the whole edge treatment (D1).
        static var recess: some ShapeStyle {
            bottom
                .shadow(.inner(color: wellShadow, radius: 6, y: 2))
                .shadow(.inner(color: wellHighlight, radius: 0, y: -1))
        }
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
