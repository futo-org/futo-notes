package com.futo.notes.license

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import com.futo.notes.localization.LocalizedMessage
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import uniffi.futo_notes_ffi.LicenseAcceptance
import uniffi.futo_notes_ffi.LicensePair
import uniffi.futo_notes_ffi.LicenseStatus
import uniffi.futo_notes_ffi.licenseEvaluate

/**
 * The Kotlin shell's half of the license story, against the REAL Rust: this is
 * an instrumented test because `licenseEvaluate` and friends are the shared
 * crate behind JNI, and a JVM unit test cannot load it. What it proves is the
 * shell's own work — that a verdict is stored, rendered, ignored or announced
 * exactly as the spec says — never the rules themselves, which
 * `futo-notes-license` and `futo-notes-ffi` own and test. Mirrors iOS
 * `LicenseModelTests`.
 */
class LicenseModelTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    // A prefs file of this test's own: the app's real license must be neither
    // read nor written by a test run.
    private val preferences =
        context.getSharedPreferences("license-model-test", Context.MODE_PRIVATE)

    @After
    fun clearPreferences() {
        preferences.edit().clear().commit()
    }

    private fun model(applicationId: String = LicenseFixture.DEV_APPLICATION_ID) =
        LicenseModel(LicenseStorage(preferences), applicationId)

    private fun messagesOf(license: LicenseModel): MutableList<String> {
        val paths = mutableListOf<String>()
        license.showMessage = { message: LocalizedMessage -> paths.add(message.path) }
        return paths
    }

    @Test
    fun aStoredLicenseIsEvaluatedByLoad() = runBlocking {
        LicenseStorage(preferences).write(
            LicensePair(key = LicenseFixture.KEY, activation = LicenseFixture.ACTIVATION),
        )
        val license = model()
        // Nothing is read at construction: the shell renders first (M1).
        assertNull(license.view)

        license.load()

        assertEquals(LicenseStatus.LICENSED, license.view?.status)
        assertEquals(LicenseFixture.ISSUED_AT_MILLIS, license.view?.issuedAtMillis)
    }

    /**
     * CRITICAL (M3). The same staging license verifies under the `.dev` package
     * and fails closed under the release one — and the selector is the
     * application id, never a compile profile: both debug builds ship the
     * optimized `release-ffi` Rust, and both flavors ship the same ids.
     */
    @Test
    fun aStagingLicenseIsInvisibleToAReleaseBuild() = runBlocking {
        LicenseStorage(preferences).write(
            LicensePair(key = LicenseFixture.KEY, activation = LicenseFixture.ACTIVATION),
        )

        val release = model(LicenseFixture.RELEASE_APPLICATION_ID)
        release.load()

        assertEquals(LicenseStatus.UNLICENSED, release.view?.status)
    }

    /** A valid link replaces the stored license without confirmation and shows
     *  one toast. Storing the pair is the shell's only job here — the verdict
     *  arrived already made. */
    @Test
    fun aValidDeepLinkStoresThePairAndAnnouncesItOnce() {
        val license = model()
        val messages = messagesOf(license)

        license.handle(LicenseFixture.deepLink)

        assertEquals(LicenseStatus.LICENSED, license.view?.status)
        assertEquals(LicenseFixture.ACTIVATION, LicenseStorage(preferences).read()?.activation)
        assertEquals(listOf("license.activated"), messages)
    }

    /** A link at a host or path this app does not define is ignored SILENTLY:
     *  no toast, no navigation, nothing stored. */
    @Test
    fun anUndefinedLinkIsIgnoredSilently() {
        val license = model()
        val messages = messagesOf(license)

        license.handle("futonotes://settings/open")

        assertTrue(messages.isEmpty())
        assertNull(license.view)
        assertNull(LicenseStorage(preferences).read())
    }

    /** A license link that does not verify earns exactly one toast — and the
     *  license already on the device survives it untouched. */
    @Test
    fun anInvalidLicenseLinkChangesNothingAndSaysSoOnce() {
        val license = model()
        val messages = messagesOf(license)
        license.handle(LicenseFixture.deepLink)
        messages.clear()

        license.handle("futonotes://license/${LicenseFixture.KEY}/v2.bm90.bm90")

        assertEquals(listOf("license.linkInvalid"), messages)
        assertEquals(LicenseStatus.LICENSED, license.view?.status)
        assertEquals(LicenseFixture.ACTIVATION, LicenseStorage(preferences).read()?.activation)
    }

    /**
     * The regression this pins: [LicenseModel.load] reads the stored pair off
     * the main thread, so a link applied while that read is in flight would be
     * overwritten by whatever was on disk — the license the user just activated
     * silently replaced by the one it replaced.
     */
    @Test
    fun aLinkAppliedBeforeTheStoredPairLandsSurvivesIt() {
        val license = model()
        messagesOf(license)

        license.handle(LicenseFixture.deepLink)
        // `load()` evaluated an empty store before the link arrived; this is
        // that answer landing afterwards. Without the guard it replaces the
        // just-activated license with "nothing stored", silently.
        license.applyEvaluated(
            licenseEvaluate(stored = null, bundleId = LicenseFixture.DEV_APPLICATION_ID),
        )

        assertEquals(LicenseStatus.LICENSED, license.view?.status)
        assertEquals(LicenseFixture.ACTIVATION, LicenseStorage(preferences).read()?.activation)
    }

    @Test
    fun removeReturnsTheDeviceToUnlicensed() {
        val license = model()
        messagesOf(license)
        license.handle(LicenseFixture.deepLink)

        license.remove()

        assertEquals(LicenseStatus.UNLICENSED, license.view?.status)
        assertNull(LicenseStorage(preferences).read())
    }

    /** Full reset wipes the license like every other preference (settings.md,
     *  Danger zone) — and does it without a toast, since the user is already
     *  looking at the result of a reset. */
    @Test
    fun fullResetWipesTheStoredLicenseSilently() {
        val license = model()
        val messages = messagesOf(license)
        license.handle(LicenseFixture.deepLink)
        messages.clear()

        license.clearForFullReset()

        assertEquals(LicenseStatus.UNLICENSED, license.view?.status)
        assertNull(LicenseStorage(preferences).read())
        assertTrue(messages.isEmpty())
    }

    @Test
    fun fullResetInvalidatesAnActivationAlreadyInFlight() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val pair = LicensePair(key = LicenseFixture.KEY, activation = LicenseFixture.ACTIVATION)
        val acceptance =
            LicenseAcceptance(
                pair = pair,
                view = licenseEvaluate(pair, LicenseFixture.DEV_APPLICATION_ID),
            )
        val license =
            LicenseModel(
                storage = LicenseStorage(preferences),
                bundleId = LicenseFixture.DEV_APPLICATION_ID,
                enterLicenseKey = { _, _ ->
                    started.complete(Unit)
                    release.await()
                    acceptance
                },
            )
        val messages = messagesOf(license)

        val activation = async { license.enterKey("pending") }
        started.await()
        license.clearForFullReset()
        release.complete(Unit)

        assertFalse(activation.await())
        assertEquals(LicenseStatus.UNLICENSED, license.view?.status)
        assertNull(LicenseStorage(preferences).read())
        assertTrue(messages.isEmpty())
    }

    /** Pasting the pair into the key field is the same workflow as the link,
     *  and it must never touch the network: the activation is already in hand. */
    @Test
    fun aPastedPairActivatesOffline() = runBlocking {
        val license = model()
        messagesOf(license)

        val accepted = license.enterKey("${LicenseFixture.KEY}/${LicenseFixture.ACTIVATION}")

        assertTrue(accepted)
        assertEquals(LicenseStatus.LICENSED, license.view?.status)
        assertEquals(LicenseFixture.KEY, LicenseStorage(preferences).read()?.key)
    }

    /** The third accepted shape: the whole `futonotes://` URL, pasted rather
     *  than delivered by the OS. Recognising which shape it is belongs to Rust,
     *  so the field and the link cannot drift apart. */
    @Test
    fun aPastedLinkActivatesOffline() = runBlocking {
        val license = model()
        messagesOf(license)

        val accepted = license.enterKey(LicenseFixture.deepLink)

        assertTrue(accepted)
        assertEquals(LicenseStatus.LICENSED, license.view?.status)
    }

    /** Nothing is stored on a failure, so a bad paste leaves whatever was there
     *  alone — and the user is told the key is not valid, never why. */
    @Test
    fun anUnrecognisablePasteStoresNothing() = runBlocking {
        val license = model()
        val messages = messagesOf(license)

        val accepted = license.enterKey("not a license at all")

        assertFalse(accepted)
        assertEquals(listOf("license.keyInvalid"), messages)
        assertNull(LicenseStorage(preferences).read())
    }

    /** Whitespace is trimmed by the crate, so a key pasted with a trailing
     *  newline out of a browser still activates. */
    @Test
    fun aPairPastedWithSurroundingWhitespaceActivates() = runBlocking {
        val license = model()
        messagesOf(license)

        val accepted =
            license.enterKey("  ${LicenseFixture.KEY}/${LicenseFixture.ACTIVATION}\n")

        assertTrue(accepted)
        assertEquals(LicenseStatus.LICENSED, license.view?.status)
    }
}
