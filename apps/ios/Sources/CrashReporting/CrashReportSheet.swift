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
        // The sheet's own controls, so a crash can be answered without a tap. Modal: it
        // covers the app, and resolution must be explicit.
        .puppetVerbs(modal: true) {
            // Resolving empties the queue first, so an answered sheet offers nothing.
            reporter.pendingReports.isEmpty
                ? []
                : [
                    PuppetVerbs.Verb(
                        "SetCrashDescription", required: ["text"],
                        controls: ["crashReporting.optionalDetails"]
                    ) { arguments in
                        userNote = (arguments["text"] as? String) ?? ""
                        return ["text": userNote]
                    },
                    PuppetVerbs.Verb(
                        "SetAlwaysSendCrashReports", required: ["enabled"], booleans: ["enabled"],
                        controls: ["crashReporting.sendAutomatically"]
                    ) { arguments in
                        guard let enabled = arguments["enabled"] as? Bool else {
                            throw PuppetVerbRefusal(400, "enabled is true or false")
                        }
                        alwaysSend = enabled
                        return ["alwaysSend": alwaysSend]
                    },
                    PuppetVerbs.Verb("ToggleCrashDetails", controls: ["crashReporting.viewReport"])
                    {
                        _ in
                        showDetails.toggle()
                        return ["open": showDetails]
                    },
                    PuppetVerbs.Verb("SendCrashReport", controls: ["common.actions.send"]) {
                        guard !sending else { throw PuppetVerbRefusal(409, "already resolving") }
                        await finish(send: true).value
                    },
                    PuppetVerbs.Verb("DiscardCrashReport", controls: ["crashReporting.dontSend"]) {
                        guard !sending else { throw PuppetVerbRefusal(409, "already resolving") }
                        await finish(send: false).value
                    },
                ]
        }
    }

    /// Send and Don't Send, tapped or as verbs; the task ends once the report is resolved.
    @discardableResult
    private func finish(send: Bool) -> Task<Void, Never> {
        sending = true
        return Task {
            await reporter.resolve(send: send, alwaysSend: alwaysSend, userNote: userNote)
            sending = false
        }
    }
}
