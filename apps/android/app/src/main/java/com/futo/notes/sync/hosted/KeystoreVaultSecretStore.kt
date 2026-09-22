package com.futo.notes.sync.hosted

import com.futo.notes.SecureStore
import uniffi.futo_notes_ffi.SecretStoreException
import uniffi.futo_notes_ffi.VaultSecretStore

/**
 * Where this device keeps the vault key and the session token: the Keystore-
 * backed [SecureStore], scoped to one notes root.
 *
 * The engine names the two secrets and decides when to read or write them (ADR
 * 0003, decision 4); this only says where they live. The vault password is
 * never among them — a device set up by password and one set up by a recovery
 * key are indistinguishable afterwards, and neither is asked for anything
 * again.
 *
 * A missing entry is `null`, never an error, because a device that has not been
 * set up is the ordinary case. A refusal to *keep* a secret is an error,
 * because the alternative is a device that looks set up and is not — so writes
 * read back what they stored and say so when it did not land. UniFFI calls
 * these on Tokio workers, so nothing here touches UI.
 *
 * [deleteSyncPassword] is the odd one out, and the one entry here that is not
 * scoped to [notesRoot]: the self-hosted sync password is app-global. The
 * engine clears it the moment a hosted session starts, so this device is never
 * holding both credentials and [com.futo.notes.SyncManager.restoreSession]
 * cannot mistake a stale password for "this is a self-hosted vault". Mirrors
 * iOS `KeychainVaultSecretStore`. → docs/spec/sync.md
 */
class KeystoreVaultSecretStore(
    private val secure: SecureStore,
    private val notesRoot: String,
) : VaultSecretStore {

    override fun vaultKey(): ByteArray? = secure.loadVaultKey(notesRoot)

    override fun setVaultKey(key: ByteArray) {
        secure.storeVaultKey(notesRoot, key)
        if (secure.loadVaultKey(notesRoot) == null) {
            throw SecretStoreException.Refused("the Keystore did not keep the vault key")
        }
    }

    override fun deleteVaultKey() {
        secure.clearVaultKey(notesRoot)
    }

    override fun sessionToken(): String? = secure.loadSessionToken(notesRoot)

    override fun setSessionToken(token: String) {
        secure.storeSessionToken(notesRoot, token)
        if (secure.loadSessionToken(notesRoot) == null) {
            throw SecretStoreException.Refused("the Keystore did not keep the session token")
        }
    }

    override fun deleteSessionToken() {
        secure.clearSessionToken(notesRoot)
    }

    override fun deleteSyncPassword() {
        secure.clearPassword()
    }
}
