@MainActor
func performFullReset(
    beginStoreReset: () -> Void = {},
    disconnectSync: () async -> Void,
    resetStore: () async throws -> Void,
    clearLicense: () -> Void
) async throws {
    // Disconnect joins the live task and clears the saved credential before
    // the vault disappears, so an in-flight cycle cannot restore deleted data.
    beginStoreReset()
    await disconnectSync()
    try await resetStore()
    // The license is a preference, and Full reset wipes preferences
    // (docs/spec/license.md § Storage). Last because it touches nothing the
    // two steps above depend on, and it cannot fail. A throwing resetStore
    // skips it: the reset did not happen, so the preferences it wipes stay.
    clearLicense()
}
