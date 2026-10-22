package com.futo.notes

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings

/** This app's entry in the system settings, where a final permission refusal is undone. */
internal fun openAppSettings(context: Context) {
    context.startActivity(
        Intent(
            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.fromParts("package", context.packageName, null),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
}
