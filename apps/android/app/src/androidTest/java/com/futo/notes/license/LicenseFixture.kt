package com.futo.notes.license

/**
 * A real, verifiable staging license.
 *
 * The staging environment's baked-in key IS the conformance fixture's key pair
 * (`STAGING_PUBLIC_KEY_BASE64`, and the placeholder-keys Gap in
 * docs/spec/license.md), so these two strings — `tests/conformance/license.json`,
 * `licenseKey[0]` and `namedActivations.valid` — verify on any `.dev` build:
 * product futo-notes, issued 2026-01-15, expiring 2029-01-15. If the fixture
 * pair is ever regenerated the signature stops verifying and these tests go red,
 * which is the correct red. Same two strings as iOS `LicenseFixture.swift`.
 */
object LicenseFixture {
    const val KEY = "FN-AB12-CD34-EF56-GH78-JK12-MN34-PQ56-RS78"
    const val ACTIVATION =
        "v2.eyJrZXkiOiJGTi1BQjEyLUNEMzQtRUY1Ni1HSDc4LUpLMTItTU4zNC1QUTU2LVJTNzgiLCJwcm9kdWN0Ijoi" +
            "ZnV0by1ub3RlcyIsImlzc3VlZF9hdCI6IjIwMjYtMDEtMTVUMTA6MzA6MDBaIiwiZXhwaXJlc19hdCI6IjIw" +
            "MjktMDEtMTVUMTA6MzA6MDBaIn0.UW-vdWiyHl70QilqDEJH0xHKaJAuqfArW_UqEIoIqytuSl-y5bwaHh-0" +
            "r1KSLqGjs9q7E77X3UshG4iBnyheH84FslCUGrs5CV0QUeUd1SLym_g2dAi4XkI7RN8QoDKVY9V4ddYd13lb" +
            "vIATbgMxA_MDlKalkmvUhJ0gkxjoN2jQnf4SmUivPp38ZuwscHrorA-iy1BQhobXS3lbws9ENO4FcknQ1A5T" +
            "zWvQJ1hkUagQpWnXj1NIyOYcfqHaWSe0TD5HdXKacDVQftb_puM8YbQ5uHYSxgMdQ_rol6dKYijX0u7IhN9W" +
            "uKnCTL26_bwpwbEUtAmNDr9SKVU1iO9_Gg"

    /** What the FUTOpay activate-redirect page opens. */
    val deepLink: String get() = "futonotes://license/$KEY/$ACTIVATION"

    /** 2026-01-15T10:30:00Z, the fixture license's purchase instant. */
    const val ISSUED_AT_MILLIS = 1_768_473_000_000L

    /** The `.dev` package both the emulator and device debug builds run under. */
    const val DEV_APPLICATION_ID = "com.futo.notes.dev"
    const val RELEASE_APPLICATION_ID = "com.futo.notes"
}
