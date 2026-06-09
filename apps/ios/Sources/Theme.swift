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
        Color(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(dark)
                : UIColor(light)
        })
    }
}
