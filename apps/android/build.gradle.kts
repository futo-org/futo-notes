// Root build file. Plugin versions are declared here and applied per-module.
plugins {
    id("com.android.application") version "9.4.1" apply false
    // AGP 9 compiles Kotlin itself (built-in Kotlin), so app/ no longer applies
    // kotlin-android. Declaring it here, unapplied, only puts this KGP on the
    // build classpath: it chooses the Kotlin compiler instead of AGP's bundled
    // default, and must match the Compose compiler plugin below.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
    id("org.jetbrains.kotlin.plugin.compose") version "2.4.21" apply false
}
