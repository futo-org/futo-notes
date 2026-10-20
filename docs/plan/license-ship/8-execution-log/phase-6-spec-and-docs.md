### Phase 6 — spec and docs — DONE 2026-09-16

One commit, `docs(license): record the License card in the spec` (e6f0a158).
The spec now describes the card three device lanes actually saw, and nothing
stronger.

**`docs/spec/license.md`.** § States and copy is rewritten around the card: a
six-column table (badge · Key · Licensed since · Term · actions, per state) over
bullets for the one filled button, the badge-less Licensed state, the Term
values, D2, D4, the row arrangement, the explanation copy, the coin and the
ambient label. What was recorded as behavior, each because a lane observed it:

- Every row is present in every state and blank when the license carries no
  value for it — the thing that makes Unlicensed and a v1 license look
  deliberate rather than broken.
- **D2**: with a v1 activation the "Licensed since" row is present and blank.
  Production mints v1 today, so a blank row is what a real buyer sees.
- **D4**: the key is masked to its last group, revealed by click/tap, and
  copied; revealing and copying is local UI, no rule, and the reveal lasts only
  while the card is mounted.
- **D3** everywhere: a full localized date, never a bare year, in the card and
  in the desktop ambient footer.
- **D7**: the licensed paragraph is the single sentence.
- `term` is blank for Unlicensed, "Perpetual" for a v1 or null-expiry license,
  "Valid until {date}", "Expired {date}".
- The Licensed state wears **no badge on any platform**, with the iOS
  `license-well` accessibility-value fallback spelled out, because a QA playbook
  that reads `license-status` in the Licensed state will otherwise report a
  false failure.
- *(ios)* Paste and the deep link are the supported ways to enter an
  activation; the system keyboard's smart-dash substitution corrupts a typed v2
  pair and the app correctly rejects it. Stated under Entering a key, **not** as
  a Gap — both supported paths work.

**Gaps.** Only one was touched.

- **Narrowed** (was "the coin is desktop-only", open 2026-09-15): *"the coin
  animates only on desktop. iOS and Android show the same plate and the same
  coin as a still glyph, because a WebGL/three.js canvas is a web-shell
  affordance and re-authoring the motion per platform (SceneKit, a Compose GL
  surface) is a separate decision from adopting the coin itself, which they now
  have. Narrowed 2026-09-16 from "the coin is desktop-only" (open 2026-09-15),
  when both native plates shipped the glyph."* Narrowed rather than closed
  because the spec line above it describes a coin that turns and spins up on
  activation, and the native shells do not do that; the static glyph is
  deliberate (D5), so the note records a remaining divergence, not a defect.
- **Opened: none.** The one candidate was the Expired coverage, and it is
  recorded as prose in the dated verification block instead — see below.
- **Closed: none.** The production-key, region-gating, revocation and
  license-sync Gaps are untouched, as briefed. The "fourth state, not yet
  known" Gap kept its meaning and gained one observed detail (Android's well
  carries no accessibility label while `license.view` is null) and the word
  "card" in place of "row".

**What was refused.** The 2026-09-16 verification block says what was driven and
then, in its own paragraph, what was not:

- **Expired has never been rendered on an iPhone.** Not a code limit: the only
  staging-signed fixture expires 2029 and a simulator's clock cannot be moved
  (`xcrun simctl` has no time subcommand). On iOS the Expired card is covered by
  `LicenseCopyTests` and the `licenseRowActions` golden alone.
- **Desktop's Expired was rendered from an injected `license.view`**, not from a
  real activation — no staging-signed activation with a past expiry exists and
  the private key is not in this repo.
- Expired *was* genuinely reached on Android by moving the emulator clock, and
  the block says so rather than letting one platform's success cover three.

Why prose and not a `> **Gap:**`: a Gap marks missing or divergent *behavior*
(docs/spec/README.md). Nothing here is missing — Rust's expiry verdict has its
own tests and two shells' rendering of it simply has not been observed. That is
coverage, and the spec's dated verification paragraphs are where coverage claims
already live (#156, #160). Recording it as a Gap would also make it uncloseable
by any client change, since what unblocks it is a staging-minted activation.

**Other surfaces.** `docs/spec/list.md`'s footer line was already correct from
Phase 2 (verified, not re-edited). `docs/spec/settings.md` kept its position
statements — the section did not move — and only stopped calling the card a row.
`docs/spec/localization.md` now cites the card's three date strings and records
that **`localizedYear` has had no caller on any platform since D3**; it is kept
rather than deleted as part of a copy change, because it is a three-platform API
with its own lock on each. `crates/futo-notes-license/AGENTS.md`,
`crates/futo-notes-license/src/{lib,state,enter}.rs`,
`crates/futo-notes-ffi/src/license/contract.rs` and
`apps/tauri/src-tauri/src/license.rs` lost their "Supporter since {year}" doc
comments (M17). `docs/release/store-submission.md`'s privacy blurb and its
review-notes paragraph both did too — and the review-notes paragraph stopped
opening "FUTO Notes is free and fully functional", as did the license crate's
`lib.rs`, which said "FUTO Notes is free to use" in the crate that owns the rule
forbidding it. `docs/adr/0004` was read and left alone: it says "a cosmetic
badge" in passing, which is still true.

`rg -n "Supporter since" .` now returns **only** `docs/plan/license-ship.md`
(this document's own brief and history) and two lines inside
`docs/spec/license.md`'s dated "Decision 2026-09-10" section: the row text
observed on the emulator that day, and the sentence about what v2 buys, which
gained a parenthetical naming the current wording rather than being rewritten.
Dated records are not restated in today's words.

**Commands (each redirected to a file, `$?` read directly — never piped, M11):**

```
pnpm run check:languages  → Validated 2 language catalogs. (exit 0)
just check-agent-docs     → OK — 41 instruction files, 570 references, 0 broken (exit 0)
just check-drift          → OK — 18 concepts (7 locked, 5 partial, 6 unlocked) (exit 0)
just check                → exit 0, run twice (before and after the final wording
                            fixes): arch gates, lint (0 errors, 4 pre-existing
                            warnings), svelte-check 0/0, format:check, 1871 unit
                            tests + 390 editor tests, tsc, vite build, cargo
                            conformance + license tests, rustfmt
```

**What Phase 7 still has to prove on a device** (the spec claims none of it
today):

1. **Expired on iOS and desktop from a real stored license.** Mint *one*
   staging-signed activation with a past `expires_at` into the shared fixture
   (needs the staging private key) and the story unblocks on all three platforms
   permanently. Until then iOS has never rendered it and desktop has only
   rendered an injected view.
2. **A real staging purchase through the card** — the #160 stories against the
   new surface, on one commit, all three clients.
3. **Copy on desktop overwrites the machine's clipboard** and the app cannot
   read it back (`clipboard-manager:allow-read-text` is deliberately not
   granted); the read-back has to happen outside the app.
4. **iOS Settings stories now need a scroll** — the plate pushes the Appearance
   picker below the fold, and an off-screen `Form` row is not in the
   accessibility tree at all.
5. The production-key and macOS-LaunchServices Gaps are still Phase 8's, not
   Phase 7's.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
