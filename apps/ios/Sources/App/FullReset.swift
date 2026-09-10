func performFullReset(
    disconnectSync: () async -> Void,
    resetStore: () async -> Void,
    clearLicense: () -> Void
) async {
    // Disconnect joins the live task and clears the saved credential before
    // the vault disappears, so an in-flight cycle cannot restore deleted data.
    await disconnectSync()
    await resetStore()
    // The license is a preference, and Full reset wipes preferences
    // (docs/spec/license.md § Storage). Last because it touches nothing the
    // two steps above depend on, and it cannot fail.
    clearLicense()
}
