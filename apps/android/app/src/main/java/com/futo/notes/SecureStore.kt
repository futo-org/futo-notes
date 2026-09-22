package com.futo.notes

import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Android Keystore-backed storage for this device's sync secrets [sync.md:91]:
 * the sync password, the 32-byte vault key, and the session token. The
 * AES-256/GCM key never leaves the Keystore (alias "futo.sync", non-
 * exportable); prefs hold only the base64 iv + ciphertext, so neither a prefs
 * dump nor a device backup exposes a secret. Keystore + prefs I/O — call
 * every method off the main thread.
 *
 * The password keeps the unscoped pref keys it has always had, so an existing
 * install's saved password keeps loading. The vault key and session token are
 * scoped by notes root, because a device can hold a key for one vault while the
 * storage mode points the app at another.
 *
 * The vault key and session token have no caller yet. They exist because the
 * hosted flow holds a vault key instead of a password (client ADR 0003), and the
 * other two shells — the desktop keyring and the iOS Keychain — grew the same
 * three operations in the same change.
 */
class SecureStore(private val prefs: SharedPreferences) {

    fun storePassword(password: String) {
        storeSecret(
            "storePassword",
            Prefs.SYNC_PASSWORD_IV,
            Prefs.SYNC_PASSWORD_CT,
            password.toByteArray(Charsets.UTF_8),
        )
    }

    fun loadPassword(): String? {
        val plaintext =
            loadSecret("loadPassword", Prefs.SYNC_PASSWORD_IV, Prefs.SYNC_PASSWORD_CT) ?: return null
        return String(plaintext, Charsets.UTF_8)
    }

    fun clearPassword() {
        clearSecret(Prefs.SYNC_PASSWORD_IV, Prefs.SYNC_PASSWORD_CT)
    }

    // ── Vault key ────────────────────────────────────────────────────────

    fun storeVaultKey(notesRoot: String, key: ByteArray) {
        if (key.size != VAULT_KEY_BYTES) {
            android.util.Log.e("SecureStore", "refusing to store a ${key.size}-byte vault key")
            return
        }
        storeSecret(
            "storeVaultKey",
            scopedKey(Prefs.VAULT_KEY_IV, notesRoot),
            scopedKey(Prefs.VAULT_KEY_CT, notesRoot),
            key,
        )
    }

    /**
     * The stored vault key for [notesRoot], or null when none is stored, the
     * Keystore key was invalidated, or the stored value is not exactly
     * [VAULT_KEY_BYTES] bytes.
     */
    fun loadVaultKey(notesRoot: String): ByteArray? {
        val key = loadSecret(
            "loadVaultKey",
            scopedKey(Prefs.VAULT_KEY_IV, notesRoot),
            scopedKey(Prefs.VAULT_KEY_CT, notesRoot),
        ) ?: return null
        if (key.size != VAULT_KEY_BYTES) {
            android.util.Log.e(
                "SecureStore",
                "stored vault key is ${key.size} bytes, expected $VAULT_KEY_BYTES",
            )
            return null
        }
        return key
    }

    fun clearVaultKey(notesRoot: String) {
        clearSecret(
            scopedKey(Prefs.VAULT_KEY_IV, notesRoot),
            scopedKey(Prefs.VAULT_KEY_CT, notesRoot),
        )
    }

    // ── Session token ────────────────────────────────────────────────────

    fun storeSessionToken(notesRoot: String, token: String) {
        storeSecret(
            "storeSessionToken",
            scopedKey(Prefs.SESSION_TOKEN_IV, notesRoot),
            scopedKey(Prefs.SESSION_TOKEN_CT, notesRoot),
            token.toByteArray(Charsets.UTF_8),
        )
    }

    fun loadSessionToken(notesRoot: String): String? {
        val plaintext = loadSecret(
            "loadSessionToken",
            scopedKey(Prefs.SESSION_TOKEN_IV, notesRoot),
            scopedKey(Prefs.SESSION_TOKEN_CT, notesRoot),
        ) ?: return null
        return String(plaintext, Charsets.UTF_8)
    }

    fun clearSessionToken(notesRoot: String) {
        clearSecret(
            scopedKey(Prefs.SESSION_TOKEN_IV, notesRoot),
            scopedKey(Prefs.SESSION_TOKEN_CT, notesRoot),
        )
    }

    // ── Keystore envelope ────────────────────────────────────────────────

    private fun storeSecret(what: String, ivKey: String, ctKey: String, plaintext: ByteArray) {
        try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val ciphertext = cipher.doFinal(plaintext)
            prefs.edit()
                .putString(ivKey, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .putString(ctKey, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .apply()
        } catch (e: Exception) {
            android.util.Log.e("SecureStore", "$what failed", e)
        }
    }

    private fun loadSecret(what: String, ivKey: String, ctKey: String): ByteArray? {
        val iv = prefs.getString(ivKey, null) ?: return null
        val ct = prefs.getString(ctKey, null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
            )
            cipher.doFinal(Base64.decode(ct, Base64.NO_WRAP))
        } catch (e: Exception) {
            // Key invalidated (OS reinstall, keystore wipe) — treat as no session.
            android.util.Log.e("SecureStore", "$what failed", e)
            null
        }
    }

    private fun clearSecret(ivKey: String, ctKey: String) {
        prefs.edit()
            .remove(ivKey)
            .remove(ctKey)
            .apply()
    }

    private fun getOrCreateKey(): SecretKey {
        val keystore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keystore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    companion object {
        /**
         * Bytes in a vault key — the symmetric key the sync engine encrypts
         * notes with.
         */
        const val VAULT_KEY_BYTES = 32

        /**
         * The pref key a per-vault secret lives under. A SharedPreferences key is
         * the only handle on a stored value, so these strings are storage
         * compatibility, not cosmetics.
         */
        fun scopedKey(base: String, notesRoot: String): String = "$base:$notesRoot"

        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "futo.sync"
        private const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
