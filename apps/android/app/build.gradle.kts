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

val repositoryRootDirectory = rootProject.file("../..")
val generatedLocalizationDirectory = layout.buildDirectory.dir("generated/localization")
val generateLocalizationResources = tasks.register<Exec>("generateLocalizationResources") {
    inputs.dir(repositoryRootDirectory.resolve("languages"))
    inputs.file(repositoryRootDirectory.resolve("scripts/generate-native-language-resources.mjs"))
    outputs.dir(generatedLocalizationDirectory)
    workingDir(repositoryRootDirectory)
    commandLine("node", "scripts/generate-native-language-resources.mjs", "--android")
}

// The supporter coin is modelled once in Blender (assets/coin/build-coin.py) and
// rendered by all three shells. Staging the two files the Android renderer needs
// — the model and the prefiltered studio it reflects — rather than committing a
// second copy under app/src/main/assets keeps `assets/coin/` the only place the
// coin exists. The whole directory is NOT added as an asset source: it also holds
// the Blender script, the manifest and the iOS-only .usdz, none of which belong
// in the APK.
val generatedCoinAssetsDirectory = layout.buildDirectory.dir("generated/coin-assets")
val stageCoinAssets = tasks.register<Copy>("stageCoinAssets") {
    from(repositoryRootDirectory.resolve("assets/coin")) {
        include("futo-coin.glb")
        include("studio-env-ibl.ktx")
    }
    into(generatedCoinAssetsDirectory)
}

android {
    namespace = "com.futo.notes"
    // compileSdk 36 is the floor required by the modernized androidx stack.
    // targetSdk 36 is required for Play updates from 2026-08-31; targeting it
    // accepts mandatory edge-to-edge, predictive back by default, and ignored
    // orientation/resizability restrictions on large screens.
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
        // minSdk 28 (Android 9): the minimum supported OS version. The 7.0–8.1
        // tier (API 24–27) is dropped (github#8). Note the System WebView, which
        // gates editor rendering, updates independently of the OS — so 9/10 with
        // a stale WebView still needs the editor's legacy-WebView handling.
        minSdk = 28
        targetSdk = 36
        versionCode = (System.getenv("VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("VERSION_NAME") ?: "0.1.0"
        manifestPlaceholders["appLabel"] = "@string/app_name"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // ── Distribution flavors ────────────────────────────────────────────────
    // Where the build is DISTRIBUTED, and nothing else:
    //
    //   direct — GitLab releases, Obtainium, F-Droid. Ships the universal APK
    //            (`:app:assembleDirectRelease`). The dev-loop default, so a
    //            bare `just android-native` builds what most users install.
    //   play   — Google Play only. Ships the AAB (`:app:bundlePlayRelease`);
    //            publish:android uploads that and nothing else.
    //
    // CRITICAL: neither flavor sets an applicationIdSuffix, and both use the
    // same signingConfig. Both are `com.futo.notes` (`.dev` on debug), so a
    // Play install and a direct APK are literally the same app — a user can
    // replace one with the other and keep their notes and preferences. A
    // flavor that added a suffix would strand them with a second, empty
    // install; DistributionFlavorTest locks that against both flavors.
    //
    // BuildConfig.IS_PLAY_BUILD is the seam for Play-only behavior; nothing
    // reads it yet. Per-flavor constants belong HERE, as buildConfigField
    // entries on the two flavors below (LICENSE_LINK_OUT is the first one); a
    // `if (BuildConfig.IS_PLAY_BUILD)` branch in shared Kotlin is the
    // second choice, and a flavor-specific source set (app/src/play,
    // app/src/direct) the third — each of those needs both flavors compiled,
    // which CI and `just build-android-native` do.
    //
    // LICENSE_LINK_OUT is the store-posture flag (docs/spec/license.md § Store
    // posture), `true` on BOTH flavors at launch: the app ships the full
    // surface worldwide — key field, deep link, and the Buy link out to the
    // system browser. If Google ever objects, the answer is flipping the `play`
    // line to false, not a redesign: that hides Buy, Renew and Lost-your-key
    // and keeps the key field and the deep link (the consumption-only shape
    // Play explicitly permits). WHICH controls each value produces is decided
    // once in Rust (`licenseRowActions`), so this flag cannot come to mean
    // something different here than it does on iOS. It is a build-time
    // constant, never a preference — a user must not be able to flip it.
    flavorDimensions += "distribution"
    productFlavors {
        create("direct") {
            dimension = "distribution"
            buildConfigField("boolean", "IS_PLAY_BUILD", "false")
            buildConfigField("boolean", "LICENSE_LINK_OUT", "true")
        }
        create("play") {
            dimension = "distribution"
            buildConfigField("boolean", "IS_PLAY_BUILD", "true")
            buildConfigField("boolean", "LICENSE_LINK_OUT", "true")
        }
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
            manifestPlaceholders["appLabel"] = "@string/app_name_debug"
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

    // Play distribution = Android App Bundle of the `play` flavor
    // (`./gradlew :app:bundlePlayRelease`).
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
    sourceSets {
        getByName("main") {
            res.srcDir(generatedLocalizationDirectory.map { it.dir("res") })
            java.srcDir(generatedLocalizationDirectory.map { it.dir("kotlin") })
            assets.srcDir(generatedCoinAssetsDirectory)
        }
        getByName("androidTest") {
            assets.srcDir(repositoryRootDirectory.resolve("tests/localization"))
        }
    }
    // libfuto_notes_ffi.so per-ABI is staged by scripts/build-rust-android.sh.
    // editor.html is staged into src/main/assets by the same flow (see README).
}

tasks.named("preBuild").configure {
    dependsOn(generateLocalizationResources)
    // Registering the directory as an asset source does NOT make the merge wait
    // for the task that fills it: the first build after a clean packaged an APK
    // with no coin in it and failed silently to the flat glyph at runtime.
    dependsOn(stageCoinAssets)
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
    implementation("androidx.compose.material3:material3")
    // View-based Material Components: supplies the app's manifest theme
    // (Theme.Material3.DayNight.NoActionBar) used as the Activity window theme.
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.5")

    // UniFFI-generated Kotlin bindings use JNA to call libfuto_notes_ffi.so.
    // 5.17.0: first version whose bundled libjnidispatch.so is 16 KB-page-aligned
    // (the fix landed across 5.16.0 + 5.17.0; 5.16.0 alone was incomplete). 5.14.0
    // SIGSEGVs on 16 KB-page devices — part of the Play 16 KB block.
    implementation("net.java.dev.jna:jna:5.17.0@aar")

    // Coroutines for the async SyncClient FFI methods.
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // Filament draws the supporter coin (com.futo.notes.ui.SupporterCoin). It is
    // the only 3D content in the app, and the reason it is worth an engine is
    // that the coin is gold: metal is defined by what it reflects, and a shape
    // with a gradient painted on it reads as a sticker however correctly it is
    // projected. gltfio loads assets/coin/futo-coin.glb; filament-utils supplies
    // KTX1Loader for the prefiltered environment.
    //
    // The version MUST match scripts/coin-ibl-pin.json: cmgen from a different
    // Filament release can write a cubemap this runtime reads as the wrong
    // lighting rather than rejecting.
    implementation("com.google.android.filament:filament-android:1.71.5")
    implementation("com.google.android.filament:gltfio-android:1.71.5")
    implementation("com.google.android.filament:filament-utils-android:1.71.5")

    debugImplementation("androidx.compose.ui:ui-tooling")
    debugImplementation("androidx.compose.ui:ui-test-manifest")

    // JVM unit tests (pure logic only — e.g. SyncManager's seed-URL selection).
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")

    androidTestImplementation(composeBom)
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
}
