@MainActor
func performFullReset(
    beginStoreReset: () -> Void = {},
    disconnectSync: () async -> Void,
    resetStore: () async throws -> Void
) async throws {
    // Disconnect joins the live task and clears the saved credential before
    // the vault disappears, so an in-flight cycle cannot restore deleted data.
    beginStoreReset()
    await disconnectSync()
    try await resetStore()
}
