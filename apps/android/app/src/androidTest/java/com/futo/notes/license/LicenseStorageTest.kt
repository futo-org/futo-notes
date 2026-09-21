package com.futo.notes.license

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.Prefs
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import uniffi.futo_notes_ffi.LicensePair

/**
 * The two plain strings, and nothing else (docs/spec/license.md § Storage).
 * Mirrors iOS `LicenseStorageTests`.
 */
class LicenseStorageTest {
    private val preferences = InstrumentationRegistry.getInstrumentation().targetContext
        .getSharedPreferences("license-storage-test", Context.MODE_PRIVATE)
    private val storage = LicenseStorage(preferences)

    @After
    fun clearPreferences() {
        preferences.edit().clear().commit()
    }

    /**
     * Verbatim, in both directions. base64url is case-sensitive and the
     * activation is signed bytes, so a storage layer that "tidies" either
     * string on the way through stops the license verifying — with no clue as
     * to why.
     */
    @Test
    fun storesAndReturnsBothStringsUntouched() {
        storage.write(LicensePair(LicenseFixture.KEY, LicenseFixture.ACTIVATION))

        val read = storage.read()

        assertEquals(LicenseFixture.KEY, read?.key)
        assertEquals(LicenseFixture.ACTIVATION, read?.activation)
    }

    /**
     * A half-written pair can never verify, so it reads as "no license" rather
     * than as a pair that fails an RSA check on every launch.
     */
    @Test
    fun aHalfWrittenPairReadsAsNoLicenseAtAll() {
        preferences.edit().putString(Prefs.LICENSE_KEY, LicenseFixture.KEY).commit()
        assertNull(storage.read())

        preferences.edit()
            .remove(Prefs.LICENSE_KEY)
            .putString(Prefs.LICENSE_ACTIVATION, LicenseFixture.ACTIVATION)
            .commit()
        assertNull(storage.read())
    }

    /** Blank is not a license either — an empty string would otherwise reach
     *  the verifier as if it were one. */
    @Test
    fun blankStringsReadAsNoLicense() {
        preferences.edit()
            .putString(Prefs.LICENSE_KEY, "   ")
            .putString(Prefs.LICENSE_ACTIVATION, LicenseFixture.ACTIVATION)
            .commit()

        assertNull(storage.read())
    }

    /** Removing a license that was never stored is the state the user asked
     *  for, not a failure. Full reset calls this too. */
    @Test
    fun clearingIsIdempotent() {
        storage.clear()
        assertNull(storage.read())

        storage.write(LicensePair(LicenseFixture.KEY, LicenseFixture.ACTIVATION))
        storage.clear()
        storage.clear()

        assertNull(storage.read())
        assertNull(preferences.getString(Prefs.LICENSE_KEY, null))
        assertNull(preferences.getString(Prefs.LICENSE_ACTIVATION, null))
    }
}
