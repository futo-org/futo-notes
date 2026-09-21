package com.futo.notes

import android.os.Build
import java.net.HttpURLConnection
import java.net.URL
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

object FeedbackSubmission {
    const val MAX_MESSAGE_LENGTH = 10_000

    private const val TAG = "FeedbackSubmission"

    private val feedbackApiUrl get() = "${CrashlogEndpoint.baseUrl}/api/feedback"

    fun body(message: String, images: List<ByteArray>): JSONObject =
        JSONObject().apply {
            put("message", message)
            put("app_version", BuildConfig.VERSION_NAME)
            put("platform", "android")
            put("os_version", "Android ${Build.VERSION.RELEASE}")
            put("device_info", "${Build.MANUFACTURER} ${Build.MODEL}")
            put(
                "images",
                JSONArray().apply {
                    for (bytes in images) {
                        put(JSONObject().put("data", Base64.getEncoder().encodeToString(bytes)))
                    }
                },
            )
        }

    suspend fun send(message: String, images: List<ByteArray>): Boolean =
        withContext(Dispatchers.IO) {
            try {
                val conn = URL(feedbackApiUrl).openConnection() as HttpURLConnection
                try {
                    conn.requestMethod = "POST"
                    conn.setRequestProperty("Content-Type", "application/json")
                    conn.connectTimeout = 10_000
                    conn.readTimeout = 30_000
                    conn.doOutput = true
                    conn.outputStream.use {
                        it.write(body(message, images).toString().toByteArray(Charsets.UTF_8))
                    }
                    conn.responseCode in 200..299
                } finally {
                    conn.disconnect()
                }
            } catch (e: Exception) {
                android.util.Log.e(TAG, "feedback upload failed", e)
                false
            }
        }
}
