package com.futo.notes

import android.app.ActivityManager
import android.content.Context
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Environment
import android.view.ViewGroup
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.enableEdgeToEdge
import java.io.File
import kotlin.system.exitProcess

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    installKotlinUncaughtHandler()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    // Bridge to expose EditorImeShield to JS as
    // window.__FutoImeShield__. This must be installed BEFORE the
    // editor mounts so the first updates are captured. The bridge is
    // safe to set synchronously — wry doesn't touch it.
    // See docs/learnings/ime-shield-workaround.md.
    webView.addJavascriptInterface(EditorImeShield, "__FutoImeShield__")

    // Wry's main_pipe calls setWebView (which fires onWebViewCreate here)
    // and THEN calls setWebViewClient on the same WebView a few JNI calls
    // later — see wry/src/android/main_pipe.rs lines 146 vs 188. If we
    // wrap synchronously here, wry promptly overwrites our wrapper and
    // onRenderProcessGone never reaches us. Defer the wrap via
    // webView.post so it runs on the next UI-thread loop iteration,
    // after wry's initial WebView setup has completed.
    webView.post { installRendererGoneHandler(webView) }
  }

  private fun installRendererGoneHandler(webView: WebView) {
    val wry = webView.webViewClient
    // Idempotency guard — onResume / post races could call this twice;
    // wrapping our own wrapper would forward to ourselves and crash.
    if (wry.javaClass.enclosingClass == MainActivity::class.java) return
    webView.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
        wry.shouldInterceptRequest(view, request)
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        wry.shouldOverrideUrlLoading(view, request)
      override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) =
        wry.onPageStarted(view, url, favicon)
      override fun onPageFinished(view: WebView, url: String) =
        wry.onPageFinished(view, url)
      override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
        wry.onReceivedError(view, request, error)
      override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        val ctx = this@MainActivity
        val didCrash = detail.didCrash()
        val rendererPriority = detail.rendererPriorityAtExit()
        val webviewPackage = describeWebViewPackage()
        val memorySummary = describeMemory(ctx)
        val appVersion = describeAppVersion(ctx)
        val errorSummary =
          if (didCrash) "WebView renderer process crashed"
          else "WebView renderer process killed by system (likely OOM)"
        val stackInfo = buildString {
          appendLine("didCrash=$didCrash")
          appendLine("rendererPriorityAtExit=$rendererPriority")
          appendLine("url=${view.url}")
          appendLine("webview=$webviewPackage")
          appendLine("memory=$memorySummary")
          appendLine("imeShield=${EditorImeShield.telemetrySummary()}")
        }
        FutoCrashWriter.writeCrashReport(
          ctx,
          "renderer_gone",
          errorSummary,
          stackInfo,
          appVersion,
        )
        // Returning true tells Android WebView we handled the situation,
        // which avoids the crashpad FATAL abort in aw_browser_terminator
        // ("Render process's crash wasn't handled by all associated
        // webviews"). The handler is "handling" it by tearing the activity
        // and process down cleanly. No SIGTRAP, no tombstone, no minidump
        // gibberish in logcat — just a graceful exit. The crash report we
        // just wrote ships on next launch.
        //
        // We don't auto-restart because Tauri's Rust singletons (notify
        // filesystem watcher, sync coordinator) are tied to this activity
        // and recreate-with-state isn't supported. exitProcess is the
        // standard pattern for "this activity owns the process; tear it
        // all down so the next launch is a fresh process."
        (view.parent as? ViewGroup)?.removeView(view)
        view.destroy()
        finishAndRemoveTask()
        exitProcess(0)
      }
    }
  }

  private fun installKotlinUncaughtHandler() {
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
      try {
        FutoCrashWriter.writeCrashReport(
          this,
          "kotlin_uncaught",
          throwable.toString(),
          throwable.stackTraceToString(),
          describeAppVersion(this),
        )
      } catch (_: Throwable) { /* best effort */ }
      // Hand off to the original handler so Android still tears down the
      // process. Do NOT swallow — the JVM is in an undefined state.
      previous?.uncaughtException(thread, throwable)
    }
  }
}

/** Real app version from PackageManager (falls back to "unknown" if the
 *  lookup fails). The previous code hardcoded "kotlin" as a placeholder,
 *  which made server-side filtering by version useless. */
private fun describeAppVersion(ctx: Context): String =
  try {
    ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "unknown"
  } catch (_: Throwable) {
    "unknown"
  }

/** Identify which Chromium build is running. Critical for triaging
 *  renderer crashes — if Android System WebView ships a regression,
 *  reports cluster on the affected version. */
private fun describeWebViewPackage(): String =
  try {
    WebView.getCurrentWebViewPackage()?.let {
      "${it.packageName} ${it.versionName ?: "?"}"
    } ?: "unknown"
  } catch (_: Throwable) {
    "unknown"
  }

/** Memory snapshot at crash time. Lets us tell an OOM kill (didCrash=false
 *  with low available memory) apart from a genuine renderer crash. */
private fun describeMemory(ctx: Context): String =
  try {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mi = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
    val mb = 1_000_000L
    "avail=${mi.availMem / mb}MB total=${mi.totalMem / mb}MB " +
      "lowMemory=${mi.lowMemory} threshold=${mi.threshold / mb}MB " +
      "memClass=${am.memoryClass}MB large=${am.largeMemoryClass}MB"
  } catch (_: Throwable) {
    "unknown"
  }

/** Write a CrashReport-shaped JSON next to where the TS/Rust reporters write.
 *  `internal` so RustWebViewClient (same module, same package) can use it
 *  from `onRenderProcessGone`. */
internal object FutoCrashWriter {
  fun writeCrashReport(
    ctx: Context,
    type: String,
    error: String,
    stack: String,
    appVersion: String = "unknown",
  ) {
    try {
      val notesDir = if (ctx.packageName.endsWith(".dev")) "fake-notes" else "futo-notes"
      val docs = ctx.getExternalFilesDir(Environment.DIRECTORY_DOCUMENTS) ?: return
      val crashlogs = File(File(docs, notesDir), ".crashlogs")
      if (!crashlogs.exists() && !crashlogs.mkdirs()) return

      val ts = System.currentTimeMillis()
      val deviceInfo =
        "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} | Android ${android.os.Build.VERSION.RELEASE} (SDK ${android.os.Build.VERSION.SDK_INT})"
      val isoTs = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
        .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
        .format(java.util.Date(ts))

      val json = buildString {
        append('{')
        appendField("error", error); append(',')
        appendField("stack", stack); append(',')
        appendField("app_version", appVersion); append(',')
        appendField("platform", "tauri-android-kotlin"); append(',')
        appendField("device_info", deviceInfo); append(',')
        appendField("timestamp", isoTs); append(',')
        appendField("type", type); append(',')
        appendField("route", "/")
        append('}')
      }
      File(crashlogs, "crash-$ts-kotlin.json").writeText(json)
    } catch (_: Throwable) { /* best effort */ }
  }

  private fun StringBuilder.appendField(key: String, value: String) {
    append('"').append(escape(key)).append("\":\"").append(escape(value)).append('"')
  }

  private fun escape(s: String): String {
    val out = StringBuilder(s.length + 8)
    for (c in s) {
      when (c) {
        '\\' -> out.append("\\\\")
        '"' -> out.append("\\\"")
        '\n' -> out.append("\\n")
        '\r' -> out.append("\\r")
        '\t' -> out.append("\\t")
        in '\u0000'..'\u001f' -> out.append(String.format("\\u%04x", c.code))
        else -> out.append(c)
      }
    }
    return out.toString()
  }
}
