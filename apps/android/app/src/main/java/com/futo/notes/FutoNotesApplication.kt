package com.futo.notes

import android.app.Application

class FutoNotesApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        PlatformTrust.install(this)
    }
}
