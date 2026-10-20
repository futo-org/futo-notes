## Device legs (hardware note)

The ticket asks for all three shells. What was actually run, and what was not:

- **Desktop — N/A, structurally.** No desktop surface mounts Milkdown on this branch:
  `MilkdownEditor.svelte` is imported only by `src/editor-embed/main.ts` (verified by grep over
  `src/`), and the desktop app mounts `MarkdownEditor.svelte` (CM6) until the swap (#111). So
  there is no Milkdown desktop behavior to audit, and every `DESKTOP‑CM6` verdict above means
  "shipped behavior unchanged by this branch, re‑audit at #111" — not "assumed to pass".
- **Android — RUN, and the fixes are proven end to end.** Pool emulator futo‑qa‑3 (claimed by
  this worktree via `just qa-claim android`; `$ANDROID_SERIAL` pinned to `emulator-5554` so the
  physical phone also attached to this machine was never touched). The dev app
  (`com.futo.notes.dev`) was built and installed from this branch, and the staged
  `apps/android/app/src/main/assets/editor.html` was confirmed byte‑identical (sha256) to a
  fresh build of the working tree, so the APK really carries the code under audit. Driven with
  a seeded table + task note, using OS‑level key input through the real soft keyboard, with the
  note file on disk as the oracle:
  - Enter in the last table row appended a row — the file gained `| phone |     |`. This is the
    fix whose absence meant a phone user could not add a table row at all.
  - The appended empty cell serialized as `|     |`, not `| <br /> |` — the serializer fix,
    confirmed on a real WebView rather than only in Chromium.
  - `- [x] done` + Enter + "next" wrote `- [x] done\n- [ ] next` — the unchecked‑split fix.
  Screenshots: the table and checkbox render as real interactive elements under Milkdown.
- **Android IME — partially run, and one attempt discarded as tool noise.** The typing above
  went through the emulator's real soft keyboard, which is genuine IME exposure for the fixed
  paths. A separate backspace‑on‑empty‑note probe was ABANDONED, not recorded: driving it by raw
  `adb shell input tap` coordinates with the keyboard up picked up the suggestion strip and
  inserted junk ("to" ×13) while deleting a header cell. That is the M21 trap, so the
  backspace‑on‑empty spec line rests on its documented upstream resolution and the bundle‑seam
  coverage, NOT on a device result from this run. No spec gap is recorded from it.
- **iOS — NOT RUN.** This machine is Linux (`xcrun`/`xcodebuild` absent), so the leg needs the
  Mac over Tailscale. Two attempts were made and both were blocked; the findings, so the next
  run does not repeat them:
  1. The Mac IS reachable (macOS 26.6.1) and HAS booted simulators, including pool devices
     `futo-qa-1`/`futo-qa-2` — so the device side is fine.
  2. But `~/Developer/futo-notes` there is **not a git repository** (`git fetch` → "fatal: not a
     git repository"), `xcodegen` is **not installed** (`which xcodegen` → not found), and there
     is no prebuilt `apps/ios/Frameworks` xcframework. So the leg needs a fresh clone plus a
     `brew install xcodegen` plus a cold `build-rust-ios` — installing toolchain on the user's
     machine, which this run did not do on its own authority.
  This is **not** claimed as evidence anywhere above.
  What stands in for it, and what does not: the iOS shell loads the SAME single‑file
  `editor.html` bytes as Android (`vite.editor.config.ts` stages one artifact into both), and
  the fixes are engine‑internal ProseMirror/remark logic in that bundle, exercised by 14
  bundle‑seam tests against those exact bytes. That is a strong argument, not a measurement:
  the untested iOS‑specific surface is WKWebView keydown delivery for Enter/Tab (hardware and
  software keyboard) and iOS text‑interaction gestures. **Recommended before #111: run
  `just test-ios-native` + a table/task smoke on a claimed simulator.** What a simulator cannot
  prove regardless (jetsam, real‑keyboard IME) remains dogfood (#110).
