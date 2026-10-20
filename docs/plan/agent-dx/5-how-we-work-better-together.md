## 5. How we work better together

- **Every session opens with the orientation line** (P1.3): worktree, slot, devices, dirty state.
  You should never have to ask "which checkout is this in?"
- **Long work leaves a ledger, not a promise.** Any task expected to outlive a context window writes
  `.futo/ledger.md` in its worktree (what was verified, with the command and result) so a killed
  session's successor resumes rather than restarts. This generalizes what `app-qa` and
  `verify-specs` already do.
- **Verification is reported as commands and results, never adjectives.** The verdict line (P2.4)
  makes that mechanical.
- **Friction goes to papercuts in the moment, and papercuts get a weekly owner** (P1.5). A log
  that is only written to is a diary.
- **Sessions that exceed the 5-hour limit park state first.** Already in the feedback memory; the
  ledger convention is how.
- **When the tool is silent, the tool is the first suspect (M21)**, and after P2.3 that suspicion
  becomes a journal query instead of a re-run.
