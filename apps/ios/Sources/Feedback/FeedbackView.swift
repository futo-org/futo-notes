import SwiftUI
import UIKit

struct FeedbackView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization
    @EnvironmentObject private var store: NotesStore

    @AppStorage("futo.feedback.draft") private var draft = ""

    #if DEBUG
        @AppStorage(CrashlogEndpoint.stagingKey) private var useStagingCrashlog = false
    #endif

    @State private var images: [Data] = []
    @State private var sending = false
    @State private var errorMessage = ""

    private var canSend: Bool {
        !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                messageField
                if !images.isEmpty { attachmentStrip }
                if !errorMessage.isEmpty { errorText }
                actions
                #if DEBUG
                    stagingSection
                #endif
            }
            .padding(16)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.background)
        .tint(Theme.primary)
        .navigationTitle(localization.localizedText("settings.issueReporting.sendFeedback"))
        .navigationBarTitleDisplayMode(.inline)
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(images.enumerated()), id: \.offset) { index, data in
                    attachmentThumbnail(data: data, index: index)
                }
            }
        }
    }

    private var errorText: some View {
        Text(errorMessage)
            .font(.caption)
            .foregroundStyle(Theme.danger)
    }

    private var actions: some View {
        Button {
            Task { await send() }
        } label: {
            Text(
                sending
                    ? localization.localizedText("feedback.sending")
                    : localization.localizedText("common.actions.send")
            ).frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .disabled(!canSend)
    }

    #if DEBUG
        private var stagingSection: some View {
            VStack(alignment: .leading, spacing: 8) {
                Divider()
                Toggle(
                    localization.localizedText("feedback.stagingServer"), isOn: $useStagingCrashlog
                )
                .font(.subheadline)
                Text(CrashlogEndpoint.devBaseUrl(useStaging: useStagingCrashlog))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    #endif

    private var messageField: some View {
        FeedbackMessageField(text: $draft)
            .frame(minHeight: 160)
            .padding(EdgeInsets(top: 10, leading: 10, bottom: 44, trailing: 10))
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(Color.secondary.opacity(0.25))
            )
            .overlay(alignment: .topLeading) {
                if draft.isEmpty {
                    Text(localization.localizedText("feedback.placeholder"))
                        .foregroundStyle(.secondary)
                        .padding(10)
                        .allowsHitTesting(false)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                Button {
                    pickImages()
                } label: {
                    Image(systemName: "photo")
                        .font(.system(size: 18))
                        .foregroundStyle(Color.secondary)
                        .padding(16)
                }
                .disabled(images.count >= FeedbackImages.maxAttachments)
                .accessibilityLabel(localization.localizedText("feedback.addScreenshot"))
            }
    }

    @ViewBuilder
    private func attachmentThumbnail(data: Data, index: Int) -> some View {
        ZStack(alignment: .topTrailing) {
            if let image = UIImage(data: data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 72, height: 72)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            Button {
                images.remove(at: index)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.white, .black.opacity(0.6))
            }
            .padding(2)
            .accessibilityLabel(
                localization.localizedText(
                    "feedback.removeScreenshot", arguments: ["index": index + 1])
            )
        }
    }

    private func pickImages() {
        let remaining = FeedbackImages.maxAttachments - images.count
        guard remaining > 0 else { return }
        errorMessage = ""
        ImagePicker.present(source: "library", limit: remaining) { picked in
            Task {
                let normalized = await Task.detached {
                    picked.map(FeedbackImages.normalize)
                }.value
                images.append(contentsOf: normalized.compactMap { $0 })
                if normalized.contains(where: { $0 == nil }) {
                    errorMessage = localization.localizedText("feedback.screenshotsTooLarge")
                }
            }
        }
    }

    private func send() async {
        guard canSend else { return }
        sending = true
        errorMessage = ""
        do {
            try await FeedbackSubmission.send(
                message: draft.trimmingCharacters(in: .whitespacesAndNewlines),
                images: images
            )
            draft = ""
            images = []
            store.showTransient(LocalizedMessage("feedback.sentThanks"))
            dismiss()
        } catch {
            errorMessage = localization.localizedText(
                "feedback.sendFailed", arguments: ["reason": error.localizedDescription])
        }
        sending = false
    }
}
