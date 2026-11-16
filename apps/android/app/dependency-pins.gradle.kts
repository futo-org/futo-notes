// What ships, pinned. Applied from build.gradle.kts.

// Lock the release runtime classpath of each distribution flavor.
// app/gradle.lockfile lists every library in the APK, transitive ones included,
// so the weekly FUTO dependency scan (Trivy reads lockfiles, not build scripts)
// can see them, and a build fails if resolution drifts from it. After changing a
// dependency, refresh it: `just android-lock`.
configurations.matching { it.name.endsWith("ReleaseRuntimeClasspath") }.configureEach {
    resolutionStrategy.activateDependencyLocking()
}

dependencies {
    constraints {
        // CameraX reaches Guava through media3 at 33.3.1-android, which carries
        // CVE-2026-102554 (HIGH, fixed in 33.7.2). Drop this once CameraX itself
        // resolves a fixed Guava.
        "implementation"("com.google.guava:guava:33.7.2-android")
    }
}
