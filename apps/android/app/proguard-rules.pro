# R8/ProGuard keep rules for the native FUTO Notes Android app.
#
# Minification is enabled on release builds to (a) shrink the app and (b)
# produce the deobfuscation mapping file Play asks for. The app reaches native
# code through JNA (UniFFI bindings) and exposes a WebView JS bridge — both rely
# on names surviving verbatim, so they must be kept explicitly.

# ── JNA ──────────────────────────────────────────────────────────────────
# JNA maps Java method/field names directly to native symbols and reads struct
# field order reflectively. Renaming or stripping any of it breaks the FFI.
-keep class com.sun.jna.** { *; }
-keepclassmembers class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.Structure { *; }
-dontwarn java.awt.**

# ── UniFFI-generated bindings (uniffi.futo_notes_ffi) ─────────────────────
# The generated code declares a JNA Library interface whose method names map
# 1:1 to exported Rust symbols, JNA Structure subclasses with @FieldOrder, and
# Callback interfaces invoked from native. None of these may be renamed.
-keep class uniffi.futo_notes_ffi.** { *; }
-keepclassmembers class uniffi.futo_notes_ffi.** { *; }

# ── WebView JS bridge ─────────────────────────────────────────────────────
# Methods annotated @JavascriptInterface are invoked by name from editor.html
# (window.futoBridge.*). R8 would otherwise rename/strip them.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
