import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

val releaseKeystorePropertiesFile = rootProject.file("keystore.properties")
val releaseKeystoreProperties = Properties()
val hasReleaseKeystore = releaseKeystorePropertiesFile.exists()
if (hasReleaseKeystore) {
    releaseKeystoreProperties.load(FileInputStream(releaseKeystorePropertiesFile))
}

android {
    namespace = "com.futo.notes"
    // compileSdk 36 (Android 16): required so the modernized androidx stack
    // (activity 1.12+, which brings the non-deprecated edge-to-edge path) can be
    // compiled — those artifacts declare a compileSdk-36 floor. targetSdk stays
    // 35 (below) — compileSdk only controls which APIs we can compile against,
    // targetSdk controls runtime-behavior opt-in, so we don't take on Android 16
    // runtime changes here.
    compileSdk = 36

    // Pin the NDK AGP uses for native lib stripping + debug-symbol extraction
    // (the release build's debugSymbolLevel below). Without this AGP looks for
    // its default NDK, which isn't installed, and silently skips
    // stripping/extraction ("missing strip tool for ABI"). Must match the NDK
    // CI provisions for the Rust .so build (.gitlab-ci.yml: 28.2.13676358).
    // NDK r28+ links native libs 16 KB-page-aligned BY DEFAULT (Play requires
    // 16 KB page-size support for targetSdk 35+ since 2025-11-01) — r27 needed
    // explicit -Wl,-z,max-page-size=16384 flags, r28 removes that need.
    // NOTE: do not also set ndk.dir in local.properties — a version mismatch
    // between the two breaks NDK resolution and re-triggers the skip.
    ndkVersion = "28.2.13676358"

    defaultConfig {
        applicationId = "com.futo.notes"
        minSdk = 24
        targetSdk = 35
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "0.1.0"
        manifestPlaceholders["appLabel"] = "FUTO Notes"
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                keyAlias = releaseKeystoreProperties["keyAlias"] as String
                keyPassword = releaseKeystoreProperties["password"] as String
                storeFile = file(releaseKeystoreProperties["storeFile"] as String)
                storePassword = releaseKeystoreProperties["password"] as String
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".dev"
            manifestPlaceholders["appLabel"] = "FUTO Notes Dev"
        }

        release {
            // R8 minification: shrinks the app and emits the deobfuscation
            // mapping file Play wants. Keep rules for JNA, the UniFFI bindings,
            // and the WebView JS bridge live in proguard-rules.pro.
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
            // Ship every ABI we build a .so for. x86_64 is NOT just an
            // emulator concern: de-Googled installs (ChromeOS/ARC, Waydroid,
            // Windows Subsystem for Android, x86 tablets) are common in our
            // audience, and omitting x86_64 left those devices with no matching
            // native lib — an UnsatisfiedLinkError on the universal APK, or a
            // missing-ABI-split on the Play/Aurora path. armv7 stays for older
            // 32-bit devices. Combined with the non-splitting `bundle` block
            // below, the base APK carries all three ABIs.
            ndk {
                abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64")
                // Extract native debug symbols from libfuto_notes_ffi.so into a
                // native-debug-symbols file inside the AAB so Play can
                // symbolicate native crashes/ANRs. SYMBOL_TABLE captures every
                // function name and is tied to what the Rust release-ffi lib
                // reliably carries: the symbol table kept by strip = "none"
                // (the Rust code emits no DWARF, so "FULL" would add only
                // incidental line info from C deps). AGP strips the symbol
                // table from the .so delivered to devices (~16MB → ~9.5MB);
                // the symbols travel to Play only. Requires ndkVersion above.
                debugSymbolLevel = "SYMBOL_TABLE"
            }
        }
    }

    // Play distribution = Android App Bundle (`./gradlew :app:bundleRelease`).
    // Config splits are turned OFF: with splitting on, AGP marks the base APK
    // `isSplitRequired="true"`, and any device that launches without the full
    // split set gets the OS "missing splits" recovery dialog ("Something went
    // wrong. Check that Google Play is enabled…" — that string is baked into
    // the platform, so it shows even on de-Googled devices with no Play).
    // Aurora Store reconstructs the split set from our Play AAB on de-Googled
    // devices and frequently lands an incomplete set, triggering exactly that
    // dialog. Disabling the splits makes the bundle deliver ONE self-contained
    // APK (all ABIs/densities/languages in the base), so the install can never
    // be missing a required split. Play still accepts a non-splitting AAB; the
    // only cost is a larger per-device download, which is negligible here and
    // worth it for de-Googled compatibility. This makes the Play/Aurora install
    // match the self-contained universal APK we ship via GitLab/Obtainium.
    bundle {
        abi { enableSplit = false }
        density { enableSplit = false }
        language { enableSplit = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    // libfuto_notes_ffi.so per-ABI is staged by scripts/build-rust-android.sh.
    // editor.html is staged into src/main/assets by the same flow (see README).
}

dependencies {
    // BOM bumped to the Compose 1.9.x train so material3/foundation/ui stay
    // consistent with the Compose 1.9.2 that activity 1.12.x pulls in transitively
    // (a stale BOM would leave material3 on 1.3.x against foundation 1.9.2 — skew).
    val composeBom = platform("androidx.compose:compose-bom:2025.09.01")
    implementation(composeBom)
    // enableEdgeToEdge() only stops calling the deprecated
    // Window.setStatusBarColor/setNavigationBarColor internally on API 35 as of
    // androidx.activity 1.12.0 (it draws bar scrims via a ProtectionLayout overlay
    // instead). Below 1.12 the Play "deprecated edge-to-edge APIs" warning fires
    // even through enableEdgeToEdge(). 1.12.x requires compileSdk 36 + AGP 8.9.1+.
    implementation("androidx.activity:activity-compose:1.12.4")
    // FileProvider (camera capture staging for the editor image picker).
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.compose.material3:material3")
    // View-based Material Components: supplies the app's manifest theme
    // (Theme.Material3.DayNight.NoActionBar) used as the Activity window theme.
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.navigation:navigation-compose:2.8.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.5")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.5")

    // UniFFI-generated Kotlin bindings use JNA to call libfuto_notes_ffi.so.
    // 5.17.0: first version whose bundled libjnidispatch.so is 16 KB-page-aligned
    // (the fix landed across 5.16.0 + 5.17.0; 5.16.0 alone was incomplete). 5.14.0
    // SIGSEGVs on 16 KB-page devices — part of the Play 16 KB block.
    implementation("net.java.dev.jna:jna:5.17.0@aar")

    // Coroutines for the async SyncClient FFI methods.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    debugImplementation("androidx.compose.ui:ui-tooling")

    // JVM unit tests (pure logic only — e.g. SyncManager's seed-URL selection).
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
