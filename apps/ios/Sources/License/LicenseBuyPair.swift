import SwiftUI

/// The two ways to pay where both are offered: the website and the App Store,
/// side by side, filled, one size — equal weight is equal size — each with a
/// one-line caption under it saying what it buys. Shared by the License card
/// and the app icon ask so the choice reads the same in both places.
///
/// Side by side until either label would truncate (larger text sizes), then
/// stacked, website first.
struct LicenseBuyPair: View {
    struct Choice {
        let title: String
        let caption: String
        /// Buy and Renew open the website; the arrow says so.
        let leavesApp: Bool
        let id: String
        let captionID: String
        let action: () -> Void
    }

    let web: Choice
    let appStore: Choice
    let appStoreBusy: Bool

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 12) {
                column(web, singleLine: true)
                column(appStore, singleLine: true)
            }
            VStack(spacing: 14) {
                column(web, singleLine: false)
                column(appStore, singleLine: false)
            }
        }
    }

    private func column(_ choice: Choice, singleLine: Bool) -> some View {
        VStack(spacing: 8) {
            Button(action: choice.action) {
                HStack(spacing: 5) {
                    Text(choice.title)
                        .lineLimit(singleLine ? 1 : nil)
                        .fixedSize(horizontal: singleLine, vertical: false)
                    if choice.leavesApp {
                        Image(systemName: "arrow.up.right")
                            .font(.caption2.weight(.heavy))
                            .accessibilityHidden(true)
                    }
                }
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Theme.primary, in: Capsule())
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .disabled(!choice.leavesApp && appStoreBusy)
            .accessibilityIdentifier(choice.id)
            Text(choice.caption)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                // Ideal width zero: only the button labels decide whether the
                // pair fits side by side; the captions wrap to whatever is left.
                .frame(minWidth: 0, idealWidth: 0, maxWidth: .infinity)
                .accessibilityIdentifier(choice.captionID)
        }
        .frame(maxWidth: .infinity, alignment: .top)
    }
}
