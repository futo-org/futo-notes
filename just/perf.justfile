# Physical-device performance measurements. Imported by the root justfile.

# Real keyboard typing and animated note navigation on the claimed Moto; retains frame and latency evidence.
test-android-real-input *args: qa-android-target
  node scripts/perf/android-real-input.mjs "$@"
