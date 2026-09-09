import SwiftUI

extension View {
    func transientMessageBanner(_ store: NotesStore) -> some View {
        modifier(TransientMessageBanner(store: store))
    }
}

private struct TransientMessageBanner: ViewModifier {
    @ObservedObject var store: NotesStore
    @Environment(\.localization) private var localization

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .bottom) {
                if let message = store.transientMessage {
                    Text(localization.localizedText(message.path, arguments: message.arguments))
                        .font(.subheadline)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(Capsule().fill(Color.black.opacity(0.82)))
                        .padding(.bottom, 32)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .allowsHitTesting(false)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: store.transientMessage?.path)
    }
}
