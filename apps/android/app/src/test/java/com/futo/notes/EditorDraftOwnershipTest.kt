package com.futo.notes

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorDraftOwnershipTest {
    @Test fun resetRetiresEveryPreviouslyClaimedOwner() {
        val ownership = EditorDraftOwnership()
        val first = ownership.claim()
        val second = ownership.claim()
        assertTrue(ownership.owns(first))
        assertTrue(ownership.owns(second))
        ownership.reset()
        assertFalse(ownership.owns(first))
        assertFalse(ownership.owns(second))
        val fresh = ownership.claim()
        assertTrue(ownership.owns(fresh))
        assertFalse(ownership.owns(first))
    }

    @Test fun claimIssuesDistinctTokensAndRejectsUnclaimedOwners() {
        val ownership = EditorDraftOwnership()
        assertFalse(ownership.owns(1))
        val first = ownership.claim()
        val second = ownership.claim()
        assertNotEquals(first, second)
        assertFalse(ownership.owns(second + 1))
        assertTrue(ownership.owns(first))
    }
}
