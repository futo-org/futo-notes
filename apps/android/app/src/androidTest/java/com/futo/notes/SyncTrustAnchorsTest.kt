package com.futo.notes

import java.io.ByteArrayInputStream
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncTrustAnchorsTest {
    @Test
    fun theDeviceTrustStoreYieldsParsableAnchors() {
        val anchors = SyncManager().operatingSystemTrustAnchors()

        assertTrue("the device trust store returned no anchors", anchors.isNotEmpty())

        val factory = CertificateFactory.getInstance("X.509")
        anchors.forEach { der ->
            val certificate = factory.generateCertificate(ByteArrayInputStream(der))
            assertTrue("an anchor was not an X509 certificate", certificate is X509Certificate)
        }
    }
}
