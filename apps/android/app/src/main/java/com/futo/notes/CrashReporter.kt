package com.futo.notes

import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

/**
 * Native crash pipeline [app.md:61, settings.md:43] — the Android counterpart
 * of desktop `src/features/system/crashHandler.ts` + `src/features/system/crashReporter.ts`. An
 * uncaught-exception handler writes a JSON report into `<vault>/.crashlogs/`
 * on the way down (then chains to the platform handler, which kills the
 * process); the NEXT launch scans the folder — backgrounded, never gating
 * render — and either auto-sends or shows the crash dialog (see MainActivity).
 */
object CrashReporter {
    private const val TAG = "CrashReporter"
    private const val CRASHLOGS_DIR = ".crashlogs"

    // POST mirror of src/features/system/crashReporter.ts: same /api/crash + /api/crashes
    // routes; debug builds target the dev collector through the emulator's
    // host loopback, release builds target production.
    private val baseUrl =
        if (BuildConfig.DEBUG) "http://10.0.2.2:5100" else "https://notes-crashlog.futo.org"

    /** Per-launch session id — mirrors the desktop `sessionId` UUID. */
    val sessionId: String = UUID.randomUUID().toString()

    @Volatile private var installed = false

    /** Install the uncaught-exception handler. Chains to the previous handler
     *  (the platform default = rethrow semantics: Android still logs the crash
     *  and kills the process; we only persist a report on the way out).
     *  Install-once: onCreate runs again on Activity recreation in the same
     *  process, and re-chaining would make the handler chain to itself. */
    fun install(vaultRoot: File, version: String) {
        if (installed) return
        installed = true
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, e ->
            runCatching { writeReport(vaultRoot, version, e) }
            previous?.uncaughtException(thread, e)
        }
    }

    private fun writeReport(vaultRoot: File, version: String, e: Throwable) {
        val dir = File(vaultRoot, CRASHLOGS_DIR).apply { mkdirs() }
        val ts = System.currentTimeMillis()
        val iso = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }
            .format(Date(ts))
        val report = JSONObject().apply {
            put("type", "native_crash")
            put("message", e.toString())
            put("error", e.toString()) // desktop schema name (crashHandler.ts CrashReport.error)
            put("stack", e.stackTraceToString().take(8000))
            put("timestamp", iso)
            put("session_id", sessionId)
            put("platform", "android-native")
            put("version", version)
            put("app_version", version) // desktop schema name
            put("device_info", "${Build.MANUFACTURER} ${Build.MODEL} | Android ${Build.VERSION.RELEASE}")
            put("os_version", Build.VERSION.RELEASE)
        }
        File(dir, "crash-$ts.json").writeText(report.toString())
    }

    /** Pending crash logs, oldest first. Disk I/O — call off-main. */
    fun pending(vaultRoot: File): List<File> =
        File(vaultRoot, CRASHLOGS_DIR)
            .listFiles { f -> f.name.endsWith(".json") }
            ?.sortedBy { it.name }
            ?: emptyList()

    /** Delete every pending report (user chose "Don't Send"). Off-main. */
    fun discardAll(vaultRoot: File) {
        pending(vaultRoot).forEach { it.delete() }
    }

    /**
     * Send everything pending: batch endpoint first, falling back to
     * per-report sends — the exact strategy of desktop `sendAllPendingReports`.
     * Sent reports are deleted; failures stay on disk for the next launch.
     * Returns (sent, failed). Network — call off-main.
     */
    fun sendAll(vaultRoot: File, userNote: String?): Pair<Int, Int> {
        val parsed = pending(vaultRoot).mapNotNull { file ->
            runCatching { JSONObject(file.readText()) }.getOrNull()?.let { report ->
                if (!userNote.isNullOrBlank()) {
                    report.put("user_note", userNote)
                    report.put("user_description", userNote) // desktop payload name
                }
                file to report
            }
        }
        if (parsed.isEmpty()) return 0 to 0

        // Try batch send first.
        val batch = JSONObject().put("crashes", JSONArray(parsed.map { it.second }))
        if (post("$baseUrl/api/crashes", batch.toString())) {
            parsed.forEach { it.first.delete() }
            return parsed.size to 0
        }

        // Fallback: send individually.
        var sent = 0
        var failed = 0
        for ((file, report) in parsed) {
            if (post("$baseUrl/api/crash", report.toString())) {
                file.delete()
                sent++
            } else {
                failed++
            }
        }
        return sent to failed
    }

    private fun post(url: String, body: String): Boolean = try {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.setRequestProperty("Content-Type", "application/json")
            conn.connectTimeout = 10_000
            conn.readTimeout = 10_000
            conn.doOutput = true
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            conn.responseCode in 200..299
        } finally {
            conn.disconnect()
        }
    } catch (e: Exception) {
        android.util.Log.e(TAG, "crash upload failed", e)
        false
    }
}
