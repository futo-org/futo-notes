import SwiftUI

struct AppIconPicker: View {
    let controller: AppIconController
    @Environment(\.dismiss) private var dismiss
    @Environment(\.localization) private var localization
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if !controller.available {
                        Text(localization.localizedText("settings.appIcon.unavailable"))
                    }
                    if controller.changing {
                        ProgressView(localization.localizedText("settings.appIcon.changing"))
                    }
                    if controller.failed {
                        Text(localization.localizedText("settings.appIcon.failed"))
                            .foregroundStyle(.red)
                            .accessibilityAddTraits(.updatesFrequently)
                    }
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
                        ForEach(AppIcon.allCases) { icon in
                            Button {
                                Task { await controller.select(icon) }
                            } label: {
                                VStack(spacing: 8) {
                                    Image(icon.previewName)
                                        .resizable().scaledToFit()
                                        .frame(width: 80, height: 80)
                                        .clipShape(RoundedRectangle(cornerRadius: 16))
                                    Text(localization.localizedText(icon.labelKey))
                                        .multilineTextAlignment(.center)
                                    Image(systemName: "checkmark.circle.fill")
                                        .opacity(controller.selected == icon ? 1 : 0)
                                }
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .padding(12)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
                            }
                            .buttonStyle(.plain)
                            .disabled(controller.changing || !controller.available)
                            .accessibilityLabel(localization.localizedText(icon.labelKey))
                            .accessibilityAddTraits(controller.selected == icon ? .isSelected : [])
                            .accessibilityIdentifier("app-icon-" + icon.id)
                        }
                    }
                }
                .padding()
            }
            .navigationTitle(localization.localizedText("settings.appIcon.heading"))
            .navigationBarTitleDisplayMode(.inline)
            .tint(Theme.primary)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(localization.localizedText("common.actions.done")) { dismiss() }
                }
            }
        }
        .onAppear { controller.refresh() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { controller.refresh() }
        }
    }
}
