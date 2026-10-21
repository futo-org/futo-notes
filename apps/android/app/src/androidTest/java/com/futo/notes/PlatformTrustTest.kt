package com.futo.notes

import android.content.Context
import android.os.ParcelFileDescriptor
import android.os.Process
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.KeyManager
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Assume.assumeTrue
import org.junit.Test
import uniffi.futo_notes_ffi.SyncClient

class PlatformTrustTest {
    @Test
    fun theJniSymbolIsExportedUnderTheNameKotlinDeclares() {
        PlatformTrust.install(InstrumentationRegistry.getInstrumentation().targetContext)

        assertTrue("the TLS verifier did not bind to the Android runtime", PlatformTrust.isBound)
    }

    @Test
    fun theUniffiLoadedLibraryVerifiesThroughTheBoundRuntime() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        PlatformTrust.install(context)
        val serverFailures = CopyOnWriteArrayList<Throwable>()
        val server = selfSignedTlsServer(serverFailures)
        val notesRoot = File(context.cacheDir, "platform-trust-test").apply { mkdirs() }

        val failure = try {
            runBlocking {
                SyncClient(notesRoot.absolutePath, "https://127.0.0.1:${server.localPort}")
                    .connect("password")
            }
            fail("a self-signed server must be rejected")
            return
        } catch (error: Exception) {
            generateSequence<Throwable>(error) { it.cause }.joinToString { it.toString() }
        } finally {
            server.close()
        }

        assertTrue(
            "expected the platform verifier to reject the certificate, got: $failure; server saw: $serverFailures",
            failure.contains("invalid peer certificate"),
        )
    }

    @Test
    fun aUserCaInstalledOrRemovedWhileTheAppRunsDecidesTheVeryNextConnection() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        assumeTrue("editing the user CA store needs root", asRoot(context, "id").contains("uid=0"))
        PlatformTrust.install(context)
        val userCas = "/data/misc/user/${Process.myUid() / 100_000}/cacerts-added"
        val staged = File(context.cacheDir, "user-ca").apply { mkdirs() }
        listOf("authority.der", "sibling-authority.der").forEach { name ->
            instrumentation.context.assets.open("trust/$name").use { input ->
                File(staged, name).outputStream().use { input.copyTo(it) }
            }
        }
        val installed = "$userCas/$AUTHORITY_HASH.0"
        val sibling = "$userCas/$AUTHORITY_HASH.1"
        val server = authoritySignedTlsServer(CopyOnWriteArrayList())
        val url = "https://127.0.0.1:${server.localPort}"
        try {
            val beforeInstall = connectFailure(context, url)
            assertTrue(beforeInstall, beforeInstall.contains("invalid peer certificate"))

            asRoot(
                context,
                "mkdir -p $userCas; cp $staged/authority.der $installed; " +
                    "cp $staged/sibling-authority.der $sibling; " +
                    "chown system:system $userCas $installed $sibling; chmod 755 $userCas; " +
                    "chmod 644 $installed $sibling; restorecon -R $userCas",
            )
            val afterInstall = connectFailure(context, url)
            assertFalse(afterInstall, afterInstall.contains("invalid peer certificate"))

            asRoot(context, ": > $installed")
            val afterRemoval = connectFailure(context, url)
            assertTrue(afterRemoval, afterRemoval.contains("invalid peer certificate"))
        } finally {
            asRoot(context, "rm -f $installed $sibling")
            server.close()
        }
    }

    private fun connectFailure(context: Context, url: String): String {
        val notesRoot = File(context.cacheDir, "platform-trust-test").apply { mkdirs() }
        return try {
            runBlocking { SyncClient(notesRoot.absolutePath, url).connect("password") }
            "connected"
        } catch (error: Exception) {
            generateSequence<Throwable>(error) { it.cause }.joinToString { it.toString() }
        }
    }

    private fun asRoot(context: Context, script: String): String {
        val file = File(context.cacheDir, "as-root.sh").apply { writeText(script) }
        val output = InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("su 0 sh ${file.absolutePath}")
        return ParcelFileDescriptor.AutoCloseInputStream(output).bufferedReader().use { it.readText() }
    }

    private fun authoritySignedTlsServer(failures: MutableList<Throwable>): SSLServerSocket {
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val leaf = assets.open("trust/leaf.der").use {
            CertificateFactory.getInstance("X.509").generateCertificate(it)
        }
        val key = KeyFactory.getInstance("EC")
            .generatePrivate(PKCS8EncodedKeySpec(assets.open("trust/leaf-key.der").use { it.readBytes() }))
        val keyStore = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null)
            setKeyEntry("leaf", key, CharArray(0), arrayOf(leaf))
        }
        val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
            .apply { init(keyStore, CharArray(0)) }
            .keyManagers
        return serveTls(keyManagers, failures)
    }

    private fun selfSignedTlsServer(failures: MutableList<Throwable>): SSLServerSocket {
        val alias = "platform-trust-test-server"
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
            initialize(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
                    .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
                    .build(),
            )
            generateKeyPair()
        }
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val keyManagers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
            .apply { init(keyStore, null) }
            .keyManagers
        return serveTls(keyManagers, failures)
    }

    private fun serveTls(keyManagers: Array<KeyManager>, failures: MutableList<Throwable>): SSLServerSocket {
        val tls = SSLContext.getInstance("TLS").apply { init(keyManagers, null, null) }
        val server = tls.serverSocketFactory.createServerSocket(0) as SSLServerSocket
        thread(isDaemon = true) {
            while (!server.isClosed) {
                runCatching { server.accept().use { it.inputStream.read() } }
                    .onFailure { if (!server.isClosed) failures += it }
            }
        }
        return server
    }

    private companion object {
        const val AUTHORITY_HASH = "d131782c"
    }
}
