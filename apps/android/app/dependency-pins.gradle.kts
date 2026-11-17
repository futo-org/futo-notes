import org.gradle.api.artifacts.dsl.LockMode

// What ships, pinned. Applied from build.gradle.kts.

// Lock the release runtime classpath of each distribution flavor.
// app/gradle.lockfile lists every library in the APK, transitive ones included,
// so the weekly FUTO dependency scan (Trivy reads lockfiles, not build scripts)
// can see them, and a build fails if resolution drifts from it. After changing a
// dependency, refresh it: `just android-lock`.
val shippedClasspaths = configurations.matching { it.name.endsWith("ReleaseRuntimeClasspath") }
shippedClasspaths.configureEach {
    resolutionStrategy.activateDependencyLocking()
}
// STRICT: a release classpath with no lock state fails instead of resolving
// unlocked (DEFAULT would quietly build from whatever resolves).
dependencyLocking {
    lockMode.set(LockMode.STRICT)
}

// `just android-lock` runs this with --write-locks. Resolving each shipped
// classpath (not the `dependencies` report, which prints FAILED and exits 0)
// makes an unresolvable dependency fail the refresh instead of skipping its lock.
tasks.register("lockShippedDependencies") {
    notCompatibleWithConfigurationCache("resolves configurations at execution time")
    doFirst {
        require(gradle.startParameter.isWriteDependencyLocks) { "run with --write-locks" }
    }
    doLast {
        shippedClasspaths.forEach { it.resolve() }
    }
}

dependencies {
    constraints {
        // CameraX reaches Guava through media3 at 33.3.1-android, which carries
        // CVE-2026-102554 (HIGH, fixed in 33.7.2). Drop this once CameraX itself
        // resolves a fixed Guava.
        "implementation"("com.google.guava:guava:33.7.2-android")
    }
}
