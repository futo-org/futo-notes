## Performance

- Typing is sacred (M5): per-keystroke editor work must not scale with document
  size. The budget is a **16 ms p95 synchronous keystroke at every note size**,
  enforced by running the typing stories against the real native Android app on
  the low-end reference phone. →
  apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTypingBenchmarkTest.kt,
  `just test-android-perf`

- Opening a note is budgeted at **under 1 s at the sizes real notes reach**, and
  above them cost must scale LINEARLY — no cliff. →
  apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTypingBenchmarkTest.kt

- The FIRST focus of an opened note — the tap that starts typing — is budgeted
  at **under 1 s at real-note sizes** on the reference phone and measured for
  every fixture, blurred again before the keystroke loop. →
  apps/android/app/src/androidTest/java/com/futo/notes/textfirst/TextFirstTypingBenchmarkTest.kt
- Per-keystroke work does not scale with the number of links on screen times the
  vault. Rendering a wikilink needs the whole note-id list twice — once to resolve
  the target, once for the shortest unique display suffix — so both go through one
  index (`getWikilinkIndex`), never per link; `[[` completion shares it. The
  index is rebuilt whole whenever the note list changes, which a save
  mid-typing does, so the keystroke after an autosave pays one pass over the whole
  vault — tens of ms at 8,000 ids and over 100 ms at 50,000 in a Node
  microbenchmark of the build alone, never measured in a shipped engine, so treat
  those as a floor: a very large vault pays a real hitch there, and profiling it
  against these numbers will mislead. → wikilinks.ts, notes.svelte.ts
- The native Android text-first editor's open, streaming and command performance: [Android text-first editor](performance/android-text-first.md)
