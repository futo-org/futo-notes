### Phase 7 — release gate against staging — DONE 2026-09-16

Three legs (desktop / iOS / Android) ran issue #160's criteria on one commit
(`6ee0fa89`), each story observed on screen **and** against storage. **All three
verdicts: SHIP.** Results are recorded in `docs/spec/license.md`'s dated
verification block; this is the operational residue.

- **Desktop** — 7/7 assigned stories PASS. Story 3 (real purchase) and story 8
  (`play` flavor) belong to the native legs by design.
- **iOS** — PASS on 1, 2, 3, 5, 6, 7, 9 and three of four input shapes. A fresh
  real staging purchase was completed on this commit, not carried over from
  2026-09-15.
- **Android** — 9/9 PASS **plus** Expired from a real stored license, which no
  other platform can reach.

Not obtained, with reasons (do not re-report as failures): the iOS
bare-key-offline case, the desktop OS-browser paint, and desktop's native
Full-reset confirm sheet. Expired remains unproven on desktop and iOS; per
@justin 2026-09-16 that is accepted rather than fixed by minting an expired
staging activation, and it is moot in production, which mints perpetual v1
licenses. All three are written into the spec.

**Tooling traps this pass paid for — read before the next multi-leg QA run:**

- `just qa-release` / `scripts/qa.mjs release` has **no per-platform filter**; it
  releases every platform the worktree claimed. Two lanes sharing one worktree
  means whichever finishes first silently drops the other's device. It cost this
  pass twice. Papercut `pc_0e272e90969a`.
- `adb shell input text` truncates at ~250 characters. The 584-character v2
  fixture must be sent in chunks or the activation fails in a way that looks
  exactly like a rejected key.
- Under heavy host load (this machine ran load average 18-23 from parallel
  worktree builds) Chrome ANRs mid-checkout and a WebKit window suspends
  `requestAnimationFrame` while occluded. Both look like product defects and are
  not. Suspect the tool before the app (M21).
- Desktop QA of Copy overwrites the machine's clipboard, and the app cannot read
  it back by design — verify from outside the app.

**Not done, deliberately** (@justin, 2026-09-16): issues #160 and #161 were left
open and MR !303 was left in Draft. The branch still carries a fail-closed
placeholder production key, so what happens to it next is a human call. Phase 8
is untouched.
