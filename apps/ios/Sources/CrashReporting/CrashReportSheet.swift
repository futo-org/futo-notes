import SwiftUI

// ── Sheet ────────────────────────────────────────────────────────────────────

/// "Send crash report?" sheet shown on the launch after a native crash (unless
/// Always send is on). Mirrors the desktop CrashReportDialog: expandable
/// report, optional "What were you doing?", Always-send toggle, Send / Don't
/// Send (Don't Send = permanent opt-out, re-enable in Settings).
struct CrashReportSheet: View {
    @ObservedObject var reporter: CrashReporter
    @Environment(\.localization) private var localization

    @State private var userNote = ""
    @State private var alwaysSend = false
    @State private var showDetails = false
    @State private var sending = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(
                        localization.localizedText("crashReporting.prompt")
                    )
                }
                Section {
                    DisclosureGroup(
                        localization.localizedText("crashReporting.viewReport"),
                        isExpanded: $showDetails
                    ) {
                        ForEach(reporter.pendingReports) { pending in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(pending.summary)
                                    .font(.caption.bold())
                                Text(pending.stack)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
                Section(localization.localizedText("crashReporting.activityPrompt")) {
                    TextField(
                        localization.localizedText("crashReporting.optionalDetails"),
                        text: $userNote,
                        axis: .vertical
                    )
                    .lineLimit(2...5)
                }
                Section {
                    Toggle(
                        localization.localizedText("crashReporting.sendAutomatically"),
                        isOn: $alwaysSend
                    )
                }
                Section {
                    Button {
                        finish(send: true)
                    } label: {
                        if sending {
                            ProgressView()
                        } else {
                            Text(localization.localizedText("common.actions.send"))
                        }
                    }
                    .disabled(sending)
                    Button(
                        localization.localizedText("crashReporting.dontSend"), role: .destructive
                    ) {
                        finish(send: false)
                    }
                    .disabled(sending)
                }
            }
            .navigationTitle(localization.localizedText("crashReporting.heading"))
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.primary)
        }
        // Resolution must be explicit (Send / Don't Send) — swipe-dismiss would
        // leave the files in limbo.
        .interactiveDismissDisabled()
    }

    private func finish(send: Bool) {
        sending = true
        Task {
            await reporter.resolve(send: send, alwaysSend: alwaysSend, userNote: userNote)
            sending = false
        }
    }
}
