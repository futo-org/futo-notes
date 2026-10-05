package com.futo.notes

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import kotlin.concurrent.thread
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
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
}
