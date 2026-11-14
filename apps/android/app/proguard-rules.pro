# R8/ProGuard keep rules for the native FUTO Notes Android app.
#
# Minification is enabled on release builds to (a) shrink the app and (b)
# produce the deobfuscation mapping file Play asks for. The app reaches native
# code through JNA (UniFFI bindings), which relies on names surviving verbatim.

# ── JNA ──────────────────────────────────────────────────────────────────
# JNA maps Java method/field names directly to native symbols and reads struct
# field order reflectively. Renaming or stripping any of it breaks the FFI.
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.Structure { *; }
-dontwarn java.awt.**

# ── UniFFI-generated bindings (uniffi.futo_notes_ffi) ─────────────────────
# The generated code declares a JNA Library interface whose method names map
# 1:1 to exported Rust symbols, JNA Structure subclasses with @FieldOrder, and
# Callback interfaces invoked from native. None of these may be renamed.
-keep class uniffi.futo_notes_ffi.** { *; }

# ── rustls-platform-verifier (TLS trust) ──────────────────────────────────
-keep class org.rustls.platformverifier.** { *; }
-keepclasseswithmembernames class com.futo.notes.PlatformTrust { native <methods>; }

# Native editor JNI entry points are looked up by their JVM class/method names.
-keepclasseswithmembernames class com.futo.notes.textfirst.FastKeys { native <methods>; }
# Device QA verifies the renderer through the actual Android view hierarchy.
-keepnames class com.futo.notes.textfirst.TextFirstEditText
