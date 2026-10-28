## Feedback

The suggestion box behind Settings → **Send feedback**, on every platform. It
replaced the "Report an issue" link to the GitHub issue tracker.

- A message and up to **3 screenshots**, added from a photos icon in the
  bottom-right corner of the message box. There is no type to choose — every
  submission is a catch-all comment. Send stays disabled until the message has
  non-whitespace content; the server applies the same rule.
- Message is capped at **10,000 characters**; the server enforces the same limit.
- Screenshots are capped at **5 MB each**. A picked image is re-encoded once as
  **JPEG q95** when it is over the cap or is not a PNG/JPEG/WebP, and rejected
  with a message if it is still too large; each shell uses its own OS codec. The
  vault-insert path stays byte-faithful — feedback normalization never touches a
  note's own image.
  → `normalizeImage.ts`, `FeedbackImages.swift`, `FeedbackImages.kt`
- Sends **only** the app version, platform, OS version, device model and what the
  user typed. Deliberately no route (it leaks note titles), no session id, and
  nothing vault-derived (the notes root contains a username).
- **Independent of "Share crash reports"** — that toggle governs automatic crash
  uploads; pressing Send is explicit consent, so the form works either way.
- What the form attaches is disclosed in the privacy policy rather than in the
  form.
- On success every shell **confirms in its own idiom** with the same words,
  "Thanks. We'll read it." — a toast on every shell (iOS draws its transient banner
  over the Settings sheet as well as the note list) — and the form closes. A send that produced no visible confirmation reads as a
  send that did nothing.
- On failure the form keeps its contents so the user can retry. The **message
  text survives a restart**; attached images deliberately do not — they are
  re-pickable in two taps and would need stale-draft cleanup.
- Posts to `POST /api/feedback` on the crashlog server, requiring no account.
  Each shell posts it the same way it already posts a crash report.
  → `submitFeedback.ts`, `FeedbackSubmission.swift`, `FeedbackSubmission.kt`
- **Release builds always target production**; the target is only selectable in
  debug/dev builds, where it defaults to the local collector and a **"Send to the
  staging server"** switch at the bottom of the feedback form moves it — with
  crashes — to staging. The target is shown next to the switch, so a dev build
  can never silently post somewhere invisible.
  → `crashlogEndpoint.ts`, `CrashlogEndpoint.swift`, `CrashlogEndpoint.kt`
- Debug local collectors use the build worktree's slot-derived port;
  different slots use different collectors. → `scripts/lib/slot.mjs`

> **Gap:** the desktop form is reached from Settings only; there is no
> keyboard shortcut or command-palette entry for it.
