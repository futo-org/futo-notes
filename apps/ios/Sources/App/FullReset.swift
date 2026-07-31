func performFullReset(
    disconnectSync: () async -> Void,
    resetStore: () async -> Void
) async {
    // Disconnect joins the live task and clears the saved credential before
    // the vault disappears, so an in-flight cycle cannot restore deleted data.
    await disconnectSync()
    await resetStore()
}
