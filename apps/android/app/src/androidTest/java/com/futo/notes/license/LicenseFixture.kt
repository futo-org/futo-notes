package com.futo.notes.license

/**
 * A real, verifiable staging license.
 *
 * These two strings are signed by the FUTO Notes staging org key — the one
 * `STAGING_PUBLIC_KEY_BASE64` bakes in — so they verify on any `.dev` build
 * exactly as a purchased staging license would: product futo-notes, issued
 * 2026-01-15, expiring 2029-01-15. The license key itself does not exist
 * server-side and does not need to; nothing here reaches the network.
 *
 * They are deliberately not the conformance fixture's pair, whose key is
 * test-only and never baked into a build. Re-mint them with
 * `FUTO_NOTES_STAGING_KEY=… node scripts/gen-license-fixture.mjs --staging`
 * (the staging private key is never in this repo). Same two strings as iOS
 * `LicenseFixture.swift`. If the staging key is rotated without re-minting,
 * these tests go red — the correct red.
 */
object LicenseFixture {
    const val KEY = "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78"
    const val ACTIVATION =
        "v2.eyJrZXkiOiJGTi1BQjEyLUNEMzQtRUY1Ni1HSDc4LUpLMTItTU4zNC1QUTU2LVJTNzgiLCJwcm9kdWN0Ijoi" +
            "ZnV0by1ub3RlcyIsImlzc3VlZF9hdCI6IjIwMjYtMDEtMTVUMTA6MzA6MDBaIiwiZXhwaXJlc19hdCI6IjIw" +
            "MjktMDEtMTVUMTA6MzA6MDBaIn0.6Os6nS_93GOGFt5fd4k3XvtQsGMJ-x8Zct9RjZrZxdvHMAYtv6gvhvDc" +
            "Kf7sKzqk3eJZbtYuZDYwMykumVtESj-49_4HtolXbZRNyqJPzwZDmAWK7_9ZJuD50rxQokv1-p6oEdVX-eFA" +
            "Nw9o0SI_kxEFQeVabto3ZwGEFqzNODlSObksC8SgmEbHfJFrtUgPXy8TbcRfFAsfNKSWFSvYEIRe2RFHcU9p" +
            "G6XFd_h5kH0GGOjUmJM778C38rDyz6aedxVaMRkLjCfgJzaDqY7tB-c2ieYxjk_6AwPu3W2Sy4rDhJlFOdWg" +
            "hG96j0LOaQgc-wS_gyqQysPJBtw5G03fZg"

    /** What the FUTOpay activate-redirect page opens. */
    val deepLink: String get() = "futonotes://license/$KEY/$ACTIVATION"

    /** 2026-01-15T10:30:00Z, the fixture license's purchase instant. */
    const val ISSUED_AT_MILLIS = 1_768_473_000_000L

    /** The `.dev` package both the emulator and device debug builds run under. */
    const val DEV_APPLICATION_ID = "com.futo.notes.dev"
    const val RELEASE_APPLICATION_ID = "com.futo.notes"
}
