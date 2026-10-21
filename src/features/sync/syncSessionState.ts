// The shim's in-memory session flags, shared by the credential store, the
// hosted-session hooks and the sync runner. One object because an importer
// cannot reassign another module's `let` binding.

export const sessionState = {
  // ── Password store (OS keyring, held in memory for the session) ─────────
  //
  // The vault password lives in the OS keyring (Secret Service / Keychain /
  // Credential Manager) via the `e2ee_password_*` Tauri commands — never in
  // plaintext on disk (F6). `cachedPassword` is the in-memory copy for this
  // session (the same posture as iOS Keychain / Android Keystore, where the
  // secret is read out and kept in memory to re-derive the vault key); it lets
  // the synchronous `isE2eeConfigured()` / `hasStoredSyncPassword()` checks —
  // hit on every auto-sync trigger — stay synchronous. `null` means "no stored
  // password" (fresh install, forgotten, or keyring unavailable).

  cachedPassword: null as string | null,
  cachedAuthToken: null as string | null,
  // Bumped by every user-driven credential op; see `withCredentialLock` in
  // syncCredentialStore.ts.
  credentialGeneration: 0,

  // ── Hosted sessions ─────────────────────────────────────────────────────
  //
  // A hosted vault has no password to cache and no token on disk: both secrets
  // live in the OS keyring, keyed per notes root, and Rust reads them (ADR 0003,
  // decision 4). So the password-mode configured check below cannot see one, and
  // this flag is what says "the engine is holding a hosted session this process
  // connected". It is deliberately in-memory only — a restart re-derives it from
  // Rust rather than from anything written down here.
  hostedConnected: false,

  // And this one says "this vault HAS hosted secrets", which is a different fact
  // and the one auto-sync actually needs. A connect that fails because the
  // machine came up with no network leaves the vault every bit as configured as
  // it was a moment earlier; saying otherwise is what made a hosted desktop skip
  // its own vault until somebody opened Settings. Set from the local read at
  // boot (and by a successful connect), cleared by sign-out and by a reset —
  // never persisted, for the same reason `hostedConnected` is not.
  hostedSavedVault: false,

  // ── Live sync (Rust SSE stream) ──
  liveStarted: false,
};
