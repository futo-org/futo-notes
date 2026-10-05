package com.futo.notes.license

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.futo.notes.MainActivity

/** Returns a browser deep link to the existing app instance beneath a Custom Tab. */
class LicenseLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(
            Intent(this, MainActivity::class.java)
                .setAction(intent.action)
                .setData(intent.data)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
        finish()
    }
}
