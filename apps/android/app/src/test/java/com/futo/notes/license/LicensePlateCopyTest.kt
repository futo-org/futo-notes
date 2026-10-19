package com.futo.notes.license

import com.futo.notes.ui.licenseExplanationPath
import com.futo.notes.ui.licenseWebsitePath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import uniffi.futo_notes_ffi.LicensePurchaseSurface
import uniffi.futo_notes_ffi.LicenseStatus

class LicensePlateCopyTest {
    @Test
    fun keyOnlyCopyDoesNotAskForPayment() {
        val keyOnly = LicensePurchaseSurface.KEY_ONLY
        assertEquals("license.keyOnlyExplanation", licenseExplanationPath(LicenseStatus.UNLICENSED, keyOnly))
        assertEquals("license.keyOnlyExplanation", licenseExplanationPath(LicenseStatus.EXPIRED, keyOnly))
        assertEquals("license.explanationLicensed", licenseExplanationPath(LicenseStatus.LICENSED, keyOnly))
        assertNull(licenseWebsitePath(LicenseStatus.UNLICENSED, keyOnly))
    }

    @Test
    fun linkOutCopyKeepsThePurchaseExplanation() {
        val linkOut = LicensePurchaseSurface.LINK_OUT
        assertEquals("license.explanation", licenseExplanationPath(LicenseStatus.UNLICENSED, linkOut))
        assertEquals("license.explanation", licenseExplanationPath(LicenseStatus.EXPIRED, linkOut))
        assertNull(licenseWebsitePath(LicenseStatus.UNLICENSED, linkOut))
    }

    /** `play` asks like `direct` and adds the sentence that names the website. */
    @Test
    fun namingTheWebsiteAddsTheWebsiteSentenceUntilLicensed() {
        val website = LicensePurchaseSurface.NAME_WEBSITE
        for (status in listOf(LicenseStatus.UNLICENSED, LicenseStatus.EXPIRED)) {
            assertEquals("license.explanation", licenseExplanationPath(status, website))
            assertEquals("license.websiteExplanation", licenseWebsitePath(status, website))
        }
        assertEquals("license.explanationLicensed", licenseExplanationPath(LicenseStatus.LICENSED, website))
        assertNull(licenseWebsitePath(LicenseStatus.LICENSED, website))
    }
}
