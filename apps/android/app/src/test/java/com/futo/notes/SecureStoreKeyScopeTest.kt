package com.futo.notes

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The SharedPreferences keys SecureStore's three secrets live under. A prefs key
 * is the only handle on a stored value, so these strings are storage
 * compatibility, not cosmetics. The Keystore envelope itself needs a device and
 * is covered by device QA, not here.
 */
class SecureStoreKeyScopeTest {

    @Test
    fun `the password keeps the unscoped keys it has always had`() {
        // Values written by every shipped version live under these exact keys.
        // Changing them strands a user's saved password on upgrade.
        assertEquals("sync_password_iv", Prefs.SYNC_PASSWORD_IV)
        assertEquals("sync_password_ct", Prefs.SYNC_PASSWORD_CT)
    }

    @Test
    fun `the vault key and session token are scoped by notes root`() {
        val root = "/storage/emulated/0/Documents/FUTO Notes Dev"
        assertEquals(
            "vault_key_iv:$root",
            SecureStore.scopedKey(Prefs.VAULT_KEY_IV, root),
        )
        assertEquals(
            "session_token_ct:$root",
            SecureStore.scopedKey(Prefs.SESSION_TOKEN_CT, root),
        )
    }

    @Test
    fun `two vaults on one device do not share a key`() {
        // The dev/prod data split (root AGENTS.md M3) applied to the new secrets.
        val dev = "/storage/emulated/0/Documents/FUTO Notes Dev"
        val prod = "/storage/emulated/0/Documents/FUTO Notes"
        assertNotEquals(
            SecureStore.scopedKey(Prefs.VAULT_KEY_CT, dev),
            SecureStore.scopedKey(Prefs.VAULT_KEY_CT, prod),
        )
    }

    @Test
    fun `the three secrets never collide for one vault`() {
        val root = "/storage/emulated/0/Documents/FUTO Notes Dev"
        val keys = setOf(
            Prefs.SYNC_PASSWORD_CT,
            SecureStore.scopedKey(Prefs.VAULT_KEY_CT, root),
            SecureStore.scopedKey(Prefs.SESSION_TOKEN_CT, root),
        )
        assertEquals(3, keys.size)
    }
}
