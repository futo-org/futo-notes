import SwiftUI

/// The FUTO supporter coin, turning on its spindle.
///
/// Desktop renders this coin in three.js (`src/features/license/supporterCoin.ts`)
/// — an extruded disc with the FUTO diamond punched through it, gold face over a
/// darker rim. iOS does not carry a 3D engine for one Settings ornament, so this
/// draws the SAME object by projecting it instead of modelling it, and the
/// Compose `SupporterCoin` does the identical arithmetic on Android.
///
/// The projection is the whole trick. An extruded disc of radius R and depth d,
/// turned by θ about its vertical axis, lands on screen as two copies of the flat
/// glyph: the far face at horizontal offset −(d·sinθ)/2 and the near face at
/// +(d·sinθ)/2, both squeezed horizontally to |cosθ|. Draw the far one in rim
/// gold and the near one in face gold and the coin has a rim, an inner wall
/// inside the diamond, and a silhouette that narrows to an edge — all of it for
/// the cost of drawing one asset twice.
///
/// `SupporterCoin` in the asset catalog is that glyph and the ONLY art here: no
/// path is restated in Swift, so the `supporter-coin-glyph` drift entry still
/// has exactly its three registered copies.
struct SupporterCoin: View {
    /// Geometry, as fractions of the coin's box, from `supporterCoin.ts`: the
    /// disc is radius 22 in a 48 box and the extrusion is a sixth of that radius.
    private static let discRadiusFraction: CGFloat = 22.0 / 48.0
    private static let depthFraction: CGFloat = (22.0 / 6.0) / 48.0

    /// One turn every ~5s — `BASE_SPIN` (1.25 rad/s) in desktop's units. Slow
    /// enough to read as an object rather than a spinner.
    private static let turnSeconds: Double = 5.027

    /// How dark the face goes as it turns away. Metal edge-on catches almost no
    /// key light, and without this the coin reads as a flat sticker being rotated.
    private static let edgeOnShade: CGFloat = 0.40

    /// Rim gold — `RIM_COLOR` in `supporterCoin.ts`.
    private static let rimGold = Color(red: 0.722, green: 0.525, blue: 0.043)

    /// A quarter turn short of face-on, so a still coin still shows a sliver of
    /// rim and reads as a solid object rather than a decal.
    private static let restingTurn: Double = 0.35

    let diameter: CGFloat

    /// Motion is opt-out at the OS level, so ask before spinning anything. A
    /// stopped coin still renders as a whole coin — it just holds still.
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // TimelineView drives the angle off the display's own clock rather than
        // an animation on a state variable, so the coin cannot desynchronise
        // from the run loop the way a repeating `withAnimation` can.
        TimelineView(.animation(paused: reduceMotion)) { timeline in
            coin(
                turn: reduceMotion
                    ? Self.restingTurn
                    : timeline.date.timeIntervalSinceReferenceDate
                        .truncatingRemainder(dividingBy: Self.turnSeconds)
                        / Self.turnSeconds * 2 * .pi
            )
        }
        .frame(width: diameter, height: diameter)
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func coin(turn: Double) -> some View {
        let cosine = CGFloat(cos(turn))
        let sine = CGFloat(sin(turn))
        // The squeeze. Floored so the coin never collapses to literally nothing
        // on the frame it passes through edge-on.
        let squeeze = max(abs(cosine), 0.04)
        let separation = Self.depthFraction * sine * diameter / 2
        let halfWidth = Self.discRadiusFraction * squeeze * diameter
        let halfHeight = Self.discRadiusFraction * diameter

        ZStack {
            // The extruded wall: the strip of the coin's edge visible between the
            // two faces. Drawing the faces alone leaves it out, and the coin looks
            // pinched at top and bottom, as if the two faces were floating apart
            // with nothing joining them.
            //
            // Subtracting the faces is what keeps the diamond a hole. The leftover
            // slivers sit at the silhouette's vertical extremes, nowhere near the
            // centre — until the coin is within about 5° of edge-on, where the
            // faces are narrower than the gap and the wall does reach the middle.
            // That is not a flaw: looking along a through-hole, you cannot see
            // through it.
            wall(halfWidth: halfWidth, halfHeight: halfHeight, halfGap: separation)
                .fill(Self.rimGold)
                .frame(width: diameter, height: diameter)

            // The far face, flat rim gold: what shows past the near face is the
            // rim, and what shows inside the diamond is the hole's inner wall.
            // `.template` keeps the glyph's alpha — so the diamond is still a
            // hole — and replaces its gradient with the one flat rim colour.
            glyph(template: true)
                .foregroundStyle(Self.rimGold)
                .scaleEffect(x: squeeze, y: 1)
                .offset(x: -separation)

            // The near face, keeping the glyph's own gold gradient.
            // `colorMultiply` shades what is drawn without touching alpha, so
            // the diamond stays a hole rather than filling with a dark square.
            glyph(template: false)
                .colorMultiply(Color(white: 1 - (1 - abs(cosine)) * Self.edgeOnShade))
                .scaleEffect(x: squeeze, y: 1)
                .offset(x: separation)
        }
    }

    /// The band between the two faces with both faces cut out of it.
    ///
    /// That band IS the hull of the two face ellipses minus their union: the hull
    /// is the two ellipses plus the rectangle spanning the gap (at the very top
    /// and bottom each ellipse is a single point, and the rectangle's edge runs
    /// exactly between them), so subtracting the ellipses leaves the rectangle
    /// minus the ellipses and nothing else. Empty face-on, which is correct —
    /// there is no edge to see then.
    private func wall(halfWidth: CGFloat, halfHeight: CGFloat, halfGap: CGFloat) -> Path {
        let gap = abs(halfGap)
        let middle = diameter / 2
        let band = Path(
            CGRect(
                x: middle - gap, y: middle - halfHeight,
                width: gap * 2, height: halfHeight * 2))
        let near = Path(
            ellipseIn: CGRect(
                x: middle + gap - halfWidth, y: middle - halfHeight,
                width: halfWidth * 2, height: halfHeight * 2))
        let far = Path(
            ellipseIn: CGRect(
                x: middle - gap - halfWidth, y: middle - halfHeight,
                width: halfWidth * 2, height: halfHeight * 2))
        return band.subtracting(near).subtracting(far)
    }

    /// `decorative:` and not `Image("…")`: the coin is announced by the well it
    /// sits in, and an undecorated Image hands VoiceOver the ASSET NAME — a
    /// developer string that is in no catalog.
    private func glyph(template: Bool) -> some View {
        Image(decorative: "SupporterCoin")
            .renderingMode(template ? .template : .original)
            .resizable()
            .scaledToFit()
            .frame(width: diameter, height: diameter)
    }
}
