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
    // Google Play requires targetSdk 35 (Android 15) for new apps and updates
    // since 2025-08-31. compileSdk tracks it.
    compileSdk = 35

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
            isMinifyEnabled = false
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
            // Production ships real-device ABIs only. x86_64 is staged for the
            // emulator (debug) but excluded here so it doesn't ride along in the
            // Play AAB. armv7 is kept deliberately for older 32-bit devices.
            ndk {
                abiFilters += listOf("arm64-v8a", "armeabi-v7a")
            }
        }
    }

    // Play distribution = Android App Bundle (`./gradlew :app:bundleRelease`).
    // ABI splitting (on by default) makes Play deliver one architecture's
    // libfuto_notes_ffi.so per device instead of a fat universal APK — the
    // stripped release-ffi .so per ABI stays well under Play's limits.
    bundle {
        abi { enableSplit = true }
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
    val composeBom = platform("androidx.compose:compose-bom:2024.09.02")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.9.2")
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
    implementation("net.java.dev.jna:jna:5.14.0@aar")

    // Coroutines for the async SyncClient FFI methods.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    debugImplementation("androidx.compose.ui:ui-tooling")
}
