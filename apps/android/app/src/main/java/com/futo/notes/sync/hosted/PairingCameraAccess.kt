package com.futo.notes.sync.hosted

/**
 * Whether this device can read a pairing code right now, and if not, what the
 * person can do about it.
 *
 * Android answers a permission question with two booleans that only mean
 * something together — whether the permission is held, and whether the system
 * thinks an explanation is owed — so the reading is done once, here, as a pure
 * function a JVM test can drive through every combination.
 */
enum class PairingCameraAccess {
    /** Permission held: the camera can run. */
    READY,

    /** Never asked on this device. Asking IS the moment of use, so it happens
        as this screen opens rather than anywhere earlier. */
    ASK,

    /** Refused once, and the system will let us ask again. The person gets the
        reason first, then the choice. */
    RATIONALE,

    /** Refused for good. Only the system settings screen can undo it. */
    DENIED,

    /** No camera hardware at all. Such a device can still SHOW a code. */
    NO_CAMERA,
}

/**
 * [askedAlready] is this screen's own memory of having put the system prompt
 * up, which is what separates "never asked" from "asked and refused for good":
 * Android reports `shouldShowRequestPermissionRationale == false` for both.
 */
fun pairingCameraAccess(
    hasCamera: Boolean,
    granted: Boolean,
    askedAlready: Boolean,
    shouldShowRationale: Boolean,
): PairingCameraAccess = when {
    !hasCamera -> PairingCameraAccess.NO_CAMERA
    granted -> PairingCameraAccess.READY
    !askedAlready && !shouldShowRationale -> PairingCameraAccess.ASK
    shouldShowRationale -> PairingCameraAccess.RATIONALE
    else -> PairingCameraAccess.DENIED
}
