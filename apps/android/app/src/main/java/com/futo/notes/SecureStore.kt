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
 * Android Keystore-backed storage for the sync password [sync.md:91]. The
 * AES-256/GCM key never leaves the Keystore (alias "futo.sync", non-
 * exportable); prefs hold only the base64 iv + ciphertext, so neither a prefs
 * dump nor a device backup exposes the password. Keystore + prefs I/O — call
 * every method off the main thread.
 */
class SecureStore(private val prefs: SharedPreferences) {

    fun storePassword(password: String) {
        try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            val ciphertext = cipher.doFinal(password.toByteArray(Charsets.UTF_8))
            prefs.edit()
                .putString(Prefs.SYNC_PASSWORD_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .putString(Prefs.SYNC_PASSWORD_CT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
                .apply()
        } catch (e: Exception) {
            android.util.Log.e("SecureStore", "storePassword failed", e)
        }
    }

    fun loadPassword(): String? {
        val iv = prefs.getString(Prefs.SYNC_PASSWORD_IV, null) ?: return null
        val ct = prefs.getString(Prefs.SYNC_PASSWORD_CT, null) ?: return null
        return try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)),
            )
            String(cipher.doFinal(Base64.decode(ct, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            // Key invalidated (OS reinstall, keystore wipe) — treat as no session.
            android.util.Log.e("SecureStore", "loadPassword failed", e)
            null
        }
    }

    fun clearPassword() {
        prefs.edit()
            .remove(Prefs.SYNC_PASSWORD_IV)
            .remove(Prefs.SYNC_PASSWORD_CT)
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

    private companion object {
        const val KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "futo.sync"
        const val TRANSFORM = "AES/GCM/NoPadding"
    }
}
