package com.futo.notes.license

import com.futo.notes.ui.licenseExplanationPath
import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.futo_notes_ffi.LicenseStatus

class LicensePlateCopyTest {
    @Test
    fun keyOnlyCopyDoesNotAskForPayment() {
        assertEquals("license.keyOnlyExplanation", licenseExplanationPath(LicenseStatus.UNLICENSED, false))
        assertEquals("license.keyOnlyExplanation", licenseExplanationPath(LicenseStatus.EXPIRED, false))
        assertEquals("license.explanationLicensed", licenseExplanationPath(LicenseStatus.LICENSED, false))
    }

    @Test
    fun linkOutCopyKeepsThePurchaseExplanation() {
        assertEquals("license.explanation", licenseExplanationPath(LicenseStatus.UNLICENSED, true))
        assertEquals("license.explanation", licenseExplanationPath(LicenseStatus.EXPIRED, true))
    }
}
