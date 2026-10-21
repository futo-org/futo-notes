package org.rustls.platformverifier

import android.annotation.SuppressLint
import android.content.Context
import android.net.http.X509TrustManagerExtensions
import android.os.Build
import android.os.Process
import android.util.Log
import java.io.ByteArrayInputStream
import java.io.File
import java.security.KeyStore
import java.security.KeyStoreException
import java.security.cert.CertPathValidator
import java.security.cert.CertPathValidatorException
import java.security.cert.CertificateException
import java.security.cert.CertificateExpiredException
import java.security.cert.CertificateFactory
import java.security.cert.CertificateNotYetValidException
import java.security.cert.CertificateParsingException
import java.security.cert.PKIXBuilderParameters
import java.security.cert.PKIXRevocationChecker
import java.security.cert.TrustAnchor
import java.security.cert.X509Certificate
import java.util.Date
import java.util.EnumSet
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager

// If this is updated, update the Rust definition too.
// Marked private as this is not meant to be used in Android code.
private enum class StatusCode(val value: Int) {
    Ok(0),
    Unavailable(1),
    Expired(2),
    UnknownCert(3),
    Revoked(4),
    InvalidEncoding(5),
    InvalidExtension(6),
}

// Marked private as this is not meant to be used in Android code.
private class VerificationResult(
    status: StatusCode,
    @Suppress("unused") val message: String? = null
) {
    @Suppress("unused")
    private val code: Int = status.value
}

// NOTE: All TrustManager and certificate validation methods are not thread safe. These
// are all guarded by Kotlin's `Synchronized` accessors to prevent undefined behavior.

// Only JNI and test code calls this, so unused code warnings are suppressed.
// Internal for test code - no other Kotlin code should use this object directly.
@Suppress("unused")
// We want to show a difference between Kotlin-side logs and those in Rust code
@SuppressLint("LongLogTag")
internal object CertificateVerifier {
    private const val TAG = "rustls-platform-verifier-android"

    private fun createTrustManager(keystore: KeyStore?): X509TrustManagerExtensions? {
        // This can never throw since the default algorithm is used.
        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())

        factory.init(keystore)

        val availableTrustManagers = try {
            factory.trustManagers
        } catch (e: RuntimeException) {
            Log.w(TAG, "exception thrown creating a TrustManager: $e")
            return null
        }

        for (manager in availableTrustManagers) {
            if (manager is X509TrustManager) {
                // Kotlin ensures this can't throw at runtime since it knows that
                // it must be the correct type by now.
                return X509TrustManagerExtensions(manager)
            }
        }

        Log.e(TAG, "failed to find a usable trust manager")
        return null
    }

    private fun makeLazyTrustManager(keystore: KeyStore?): Lazy<X509TrustManagerExtensions?> {
        // Ensure the keystore is loaded. Since all of the trust managers are initialized in a
        // `Lazy`, this will only run once.
        keystore?.load(null)

        return lazy { createTrustManager(keystore) }
    }

    // -- Test only --
    // Ideally, all of this will be optimized out at compile time due to not being accessed
    // in release builds.

    @get:Synchronized
    private val mockKeystore: KeyStore = KeyStore.getInstance(KeyStore.getDefaultType())

    @get:Synchronized
    private var mockTrustManager: Lazy<X509TrustManagerExtensions?> =
        makeLazyTrustManager(mockKeystore)

    @JvmStatic
    private fun addMockRoot(root: ByteArray) {
        if (!BuildConfig.TEST) {
            throw Exception("attempted to add a mock root outside a test!")
        }

        val alias = "root_${mockKeystore.size()}"
        // Throwing here is fine since test roots should always be well-formed
        val cert = certFactory.generateCertificate(ByteArrayInputStream(root))
        mockKeystore.setCertificateEntry(alias, cert)

        reloadMockData()
    }

    @JvmStatic
    private fun clearMockRoots() {
        // Reload to get a completely fresh internal state
        mockKeystore.load(null)
        reloadMockData()
    }

    @JvmStatic
    private fun reloadMockData() {
        if (mockTrustManager.isInitialized()) {
            mockTrustManager = makeLazyTrustManager(mockKeystore)
        }
    }

    // Get a list of the system's root CAs.
    // Function is public for testing only.
    @JvmStatic
    fun getSystemRootCAs(): List<X509Certificate> {
        val rootCAs = mutableListOf<X509Certificate>()

        val factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
        factory.init(systemKeystore)

        val availableTrustManagers = try {
            factory.trustManagers
        } catch (e: RuntimeException) {
            Log.w(TAG, "exception thrown creating a TrustManager: $e")
            return rootCAs
        }

        availableTrustManagers.forEach { trustManager ->
            if (trustManager is X509TrustManager) {
                rootCAs.addAll(trustManager.acceptedIssuers)
            }
        }

        return rootCAs
    }

    // -- End testing requirements --

    private val certFactory: CertificateFactory = CertificateFactory.getInstance("X.509")

    @get:Synchronized
    private val systemKeystore: KeyStore? = try {
        KeyStore.getInstance("AndroidCAStore")
    } catch (_: KeyStoreException) {
        null
    }

    @get:Synchronized
    private var systemTrustManager: Lazy<X509TrustManagerExtensions?> =
        makeLazyTrustManager(systemKeystore)

    private val userTrustDirectories: List<File> = System.getenv("ANDROID_DATA")?.let { data ->
        val userDirectory = "$data/misc/user/${Process.myUid() / 100_000}"
        listOf(File("$userDirectory/cacerts-added"), File("$userDirectory/cacerts-removed"))
    }.orEmpty()

    private var userTrustStamp: List<Triple<String, Long, Long>> = stampUserTrust()

    private fun stampUserTrust(): List<Triple<String, Long, Long>> = userTrustDirectories
        .flatMap { directory -> listOf(directory) + directory.listFiles().orEmpty() }
        .map { Triple(it.path, it.length(), it.lastModified()) }
        .sortedBy { it.first }

    @Synchronized
    private fun reloadSystemTrustIfChanged() {
        val stamp = stampUserTrust()
        if (stamp != userTrustStamp) {
            userTrustStamp = stamp
            systemTrustManager = makeLazyTrustManager(systemKeystore)
        }
    }

    @JvmStatic
    private fun verifyCertificateChain(
        @Suppress("UNUSED_PARAMETER") context: Context,
        serverName: String,
        authMethod: String,
        allowedEkus: Array<String>,
        ocspResponse: ByteArray?,
        time: Long,
        certChain: Array<ByteArray>
    ): VerificationResult {
        // Convert the array of (supposedly) DER bytes into certificates.
        val certificateChain = mutableListOf<X509Certificate>()
        certChain.forEach { certBytes ->
            val certificate = try {
                certFactory.generateCertificate(ByteArrayInputStream(certBytes))
            } catch (e: CertificateException) {
                return VerificationResult(StatusCode.InvalidEncoding)
            }
            certificateChain.add(certificate as X509Certificate)
        }

        // Will never throw `ArrayIndexOutOfBoundsException` because `rustls`'s `ServerCertVerifier` trait
        // has a mandatory `end_entity` parameter in `verify_server_cert`.
        val endEntity = certificateChain[0]

        // Check that the certificate is valid at the point of time provided by `rustls`.
        try {
            endEntity.checkValidity(Date(time))
        } catch (e: CertificateExpiredException) {
            return VerificationResult(StatusCode.Expired)
        } catch (e: CertificateNotYetValidException) {
            return VerificationResult(StatusCode.Expired)
        }

        // Check that this certificate can be used in a TLS server.
        if (!verifyCertUsage(endEntity, allowedEkus)) {
            return VerificationResult(StatusCode.InvalidExtension)
        }

        // Select the trust manager to use.
        //
        // We select them as follows:
        // - If built for release, only use the system trust manager. This should let all test-related
        // code be optimized out.
        // - If built for tests:
        //      - If the mock CA store has any values, use the mock trust manager.
        //      - Otherwise, use the system trust manager.
        reloadSystemTrustIfChanged()
        val trustManager = if (BuildConfig.TEST && mockKeystore.size() != 0) {
            mockTrustManager.value!!
        } else {
            systemTrustManager.value ?: return VerificationResult(StatusCode.Unavailable)
        }

        // Verify that the certificate chain is valid and correct, and nothing more.
        //
        // NOTE: This does not validate `serverName` is valid for the end-entity certificate.
        // That is handled in Rust as Android/Java do not currently provide a RFC 6125 compliant
        // hostname verifier. Additionally, even the RFC 2818 verifier is not available until API 24.
        //
        // `serverName` is only used for pinning/CT requirements.
        //
        // Returns the "the properly ordered chain used for verification as a list of X509Certificates.",
        // meaning a list from end-entity certificate to trust-anchor.
        val validChain = try {
            trustManager.checkServerTrusted(certificateChain.toTypedArray(), authMethod, serverName)
        } catch (e: CertificateException) {
            // In test configurations we may see `checkServerTrusted` fail once vendored test
            // certificates pass their expiry date. We try to avoid that by using a fixed
            // verification time when calling `endEntity.checkValidity` above, however we can't
            // fix the time for the `checkServerTrusted` call.
            //
            // To make diagnosing CI test failures easier we try to find the root cause of
            // checkServerTrusted failing, returning a different `StatusCode` as appropriate.
            if (BuildConfig.TEST) {
                var rootCause: Throwable? = e
                while (rootCause?.cause != null && rootCause.cause != rootCause) {
                    rootCause = rootCause.cause
                }
                return when (rootCause) {
                    is CertificateExpiredException, is CertificateNotYetValidException -> VerificationResult(
                        StatusCode.Expired,
                        rootCause.toString()
                    )

                    else -> VerificationResult(StatusCode.UnknownCert, rootCause.toString())
                }
            }
            // In non-test configurations we should have caught expiry errors earlier and
            // can simply return an unknown cert error without digging through the exception
            // cause chain.
            return VerificationResult(StatusCode.UnknownCert, e.toString())
        }

        // Try to check the revocation status of the cert, if it is supported.
        //
        // This is supported at >= API 24, but we're supporting 22 (Android 5) for the best
        // compatibility.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            val pathBelowAnchor = validChain.dropLast(1)
            if (ocspResponse == null || pathBelowAnchor.isEmpty() || validChain.first() != endEntity) {
                // Chain validation must have succeeded by this point.
                return VerificationResult(StatusCode.Ok)
            }

            val parameters = PKIXBuilderParameters(setOf(TrustAnchor(validChain.last(), null)), null)

            val validator = CertPathValidator.getInstance("PKIX")
            val revocationChecker = validator.revocationChecker as PKIXRevocationChecker

            revocationChecker.options = EnumSet.of(
                PKIXRevocationChecker.Option.SOFT_FAIL,
                PKIXRevocationChecker.Option.ONLY_END_ENTITY,
                PKIXRevocationChecker.Option.NO_FALLBACK
            )

            revocationChecker.ocspResponses = mapOf(endEntity to ocspResponse)

            // Use the custom revocation definition.
            // "Note that when a `PKIXRevocationChecker` is added to `PKIXParameters`, it clones the `PKIXRevocationChecker`;
            // thus any subsequent modifications to the `PKIXRevocationChecker` have no effect."
            //  - https://developer.android.com/reference/java/security/cert/PKIXRevocationChecker
            parameters.certPathCheckers = listOf(revocationChecker)
            // "When supplying a revocation checker in this manner, it will be used to check revocation
            // irrespective of the setting of the `RevocationEnabled` flag."
            //  - https://developer.android.com/reference/java/security/cert/PKIXRevocationChecker
            parameters.isRevocationEnabled = false

            // Validate the revocation status of the end entity certificate.
            try {
                validator.validate(certFactory.generateCertPath(pathBelowAnchor), parameters)
            } catch (e: CertPathValidatorException) {
                if (e.reason == CertPathValidatorException.BasicReason.REVOKED) {
                    return VerificationResult(StatusCode.Revoked, e.toString())
                }
            }
        } else {
            // This is allowed to be skipped since revocation checking is best-effort.
            Log.w(TAG, "did not attempt to validate OCSP due to Android version")
        }

        return VerificationResult(StatusCode.Ok)
    }

    private fun verifyCertUsage(certificate: X509Certificate, allowedEkus: Array<String>): Boolean {
        val ekus = try {
            certificate.extendedKeyUsage
        }
        // This should be unreachable, but could happen.
        catch (_: CertificateParsingException) {
            return false
        } catch (_: NullPointerException) {
            // According to Chromium's implementation, this can crash when the EKU data is malformed.
            Log.w(TAG, "exception handling certificate EKU")
            return false
        } ?: return true // If the list is empty, we have nothing to do.

        return ekus.any { allowedEkus.contains(it) }
    }
}
