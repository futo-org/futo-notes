# Plan: escalate sync errors by recourse, not by first failure

**Status:** approved by Justin 2026-08-24 — this plan changes specified intent in
`docs/spec/sync.md` (the sync-error reporting lines), and that change is explicitly
authorized. Desktop (Tauri) only; native shells get a recorded spec gap (see §7).

## 1. The incident that motivates this

2026-08-24, prod macOS app (v1.7.0), real vault. The Mac woke from sleep at 15:58:19;
the sync server is a Tailscale host (`elitedesk-1.tail6900fe.ts.net`) and the tailnet
took ~2.5 minutes to re-establish. The app's journal
(`~/Library/Application Support/com.futo.notes/journal`) recorded 14 consecutive
failed cycles from 15:58:44 to 16:01:03, all the identical transport failure
(`error sending request for url (…/objects?sinceVersion=11003)`, no HTTP status,
191–851 ms each — instant connect/DNS failure, not a timeout). First clean cycle
15:58 + 2m34s later; nothing lost, pull cursor never moved, zero conflicts.

What the user experienced: a storm of "Sync error: …" toasts plus the persistent ⚠
indicator, for an outage that was (a) transient, (b) already being retried by two
independent mechanisms, and (c) not the server's fault. Two distinct defects:

- **D1 — dedupe defeated by dual wording.** The toast dedupe fires on *message
  change* (`syncManager.svelte.ts` `raiseSyncError`, `changed` check). The TS poll
  path normalizes its error through `getSyncErrorMessage()` ("Could not reach
  server — check the URL and make sure it's running") but the live-stream path
  (`handleLiveState`) passes the Rust payload message RAW ("connect: error sending
  request for url (https://…)"). The two sources alternate during an outage, the
  text flips every time, and every flip re-toasts. Verified: both strings normalize
  to the identical message, so routing both through the normalizer collapses the
  storm to one toast. The raw path also leaks the full server URL + reqwest
  internals into user-facing UI, which `sync.md` (~line 107) says must not happen.
- **D2 — no escalation threshold.** One failed attempt raises the loud error state
  immediately. The Rust live loop explicitly models the state as transient
  (`status: "reconnecting"`, backoff 1s→2→4→8→16→30 capped —
  `crates/futo-notes-sync/src/session/live/runner.rs` `RECONNECT_BACKOFF_*`), but
  `handleLiveState` flattens any message-bearing payload into the same hard error
  as a genuine failure. There is no consecutive-failure count, no grace period,
  nothing (verified: no threshold logic anywhere in syncManager /
  reconcileSyncCompletion / syncCoordinator).

## 2. Design principle

**Classify failures by recourse.** A failure the system is already retrying and
that history says self-heals (transport-class: DNS, no route, refused/dropped
connection, timeout — this vault's journal holds 879 failures over its lifetime and
every single one is transport-class, zero HTTP statuses) is a *quiet* state until
it has persisted long enough to be genuinely wrong. A failure where retrying won't
help or the user asked for the sync is *loud immediately*.

**Never weaken reporting to silence.** `sync.md` records a 2026-06-29 incident where
per-item failures were swallowed to stderr — invisible in packaged builds — and the
spec rules exist to prevent that regression. This plan moves the *first minutes* of
a transport outage into a visible-but-quiet "reconnecting" state; it never drops a
failure on the floor. An outage that persists still escalates, on its own, with no
user action.

## 3. Classification rules

| Failure | Class | Behavior |
|---|---|---|
| Transport-class (matches `RUST_TRANSPORT_ERROR` regex or fetch `TypeError` in `syncErrorMessage.ts`), background trigger | transient | quiet "reconnecting"; escalate after threshold |
| Live-stream `status: "reconnecting"` payload with a transport-class message | transient | same |
| `auth:`-prefixed live message (401 — the live loop stops) | actionable | loud immediately |
| Any error carrying an HTTP status ("HTTP 500", 4xx …) — the server was reached and objected | actionable | loud immediately |
| Per-item failures in a *completed* cycle (`summary.failureMessage`: upload/delete HTTP failures, decrypt, rejected, checkpoint-persist, download) | actionable | loud immediately (unchanged from today) |
| Any failure of a **manual** "Sync now" / Settings connect, whatever its class | actionable | loud immediately — the user asked; the report *is* the recourse |
| Pre-sync connect failures (bad URL/password) in Settings | actionable | unchanged (local "Connect failed: …" line) |

Note: `auth: HTTP 401 …` does not match the transport regex, so it survives
`getSyncErrorMessage` untouched — verify this with a test, since D1's fix routes the
stream message through the normalizer and auth messages must NOT collapse into
"Could not reach server".

Deliberately out of scope for v1: splitting `Download (will retry)` per-item
failures into the transient bucket. Leave per-item reporting exactly as today and
note it as a possible follow-up in the spec text.

## 4. State machine (lives in `createSyncManager`)

```
healthy ──transient failure──▶ reconnecting (quiet) ──persists ≥ THRESHOLD──▶ error (⚠ + toast)
   ▲                                   │                                          │
   └──────────── clean cycle ──────────┴──────────────────────────────────────────┘
                 (or stream reconnect, per-source, as today)
```

- `RECONNECTING_GRACE_MS = 180_000` (3 minutes), a named constant with a comment
  citing the 2026-08-24 incident: post-wake tailnet re-establishment took 2m34s and
  is the canonical member of this class; 3 min absorbs it while a genuinely dead
  server still surfaces within a working session.
- **No timer needed.** Retries keep arriving on their own (15 s poll —
  `autoSyncV2.ts` `POLL_INTERVAL_MS`; ≤30 s stream backoff), so: on each transient
  failure, record `reconnectingSince ??= Date.now()`; if
  `Date.now() - reconnectingSince >= RECONNECTING_GRACE_MS`, escalate to the loud
  state (toast + `syncError`). On any clean signal, clear `reconnectingSince`.
- Escalation renders exactly what today's error state renders (same message, same
  ⚠, same Settings line, same click-to-dismiss) — only the *timing* changes.
- The existing per-source clearing semantics (`SyncErrorSource` 'sync' | 'stream';
  a clean cycle must not clear a still-broken stream) are preserved verbatim. The
  transient state needs the same per-source tracking: a stream reconnect clears a
  stream-sourced reconnecting state, a clean cycle clears a sync-sourced one.
- Click-to-dismiss on the escalated ⚠ behaves as today (dismiss, not mute).

## 5. Concrete changes

All in `src/features/sync/` unless noted. Read `src/AGENTS.md` before editing.

1. **`syncErrorMessage.ts`** — add `classifySyncError(error: unknown): 'transient' | 'actionable'`
   beside `getSyncErrorMessage`, reusing the SAME `RUST_TRANSPORT_ERROR` regex and
   fetch-TypeError check (single owner — do not duplicate the regex). A message
   that is transport-class ⇒ 'transient'; everything else ⇒ 'actionable'.

2. **`syncManager.svelte.ts`** — the heart of the change:
   - Add state: `reconnecting: boolean` ($state), `reconnectingSince`,
     per-source like the existing `syncErrorSource`.
   - Replace direct `raiseSyncError` calls at the two failure entry points with a
     `reportFailure(message, {source, class, immediate})` that owns the state
     machine. `raiseSyncError`/`clearSyncError` stay as the loud-state primitives.
   - `handleLiveState` (~line 120): route `payload.message` through
     `getSyncErrorMessage` (fixes D1); classify — `status === 'reconnecting'` with
     transient-class message ⇒ transient; `auth:` or actionable-class ⇒ immediate.
     `cycle-error` ⇒ classify the message.
   - `onSyncError` wiring (~line 170): classify; manual trigger ⇒ immediate.
   - `reconcileSyncCompletion.ts` `failureMessage` path: unchanged (actionable,
     immediate). Its clean path additionally clears `reconnecting` (sync source).
   - Expose `readonly reconnecting: boolean` on the `SyncManager` interface.

3. **`autoSyncV2.ts`** — `onSyncError` callback gains the trigger:
   `onSyncError: (error: Error, trigger: SyncTrigger) => void`. `performSync`'s
   catch already has `trigger` in scope; pass it. Internal TS callback — not IPC,
   not the bridge, no schema/contract change anywhere in this plan.

4. **`SyncStatusBar.svelte`** — new `reconnecting` prop. Render priority:
   offline > error(⚠) > syncing spinner > reconnecting > connected ✓. Reconnecting
   visual: reuse the spinner glyph muted (opacity ~0.5) with
   `aria-label="Reconnecting to sync server"` and a matching `title` — quiet,
   legible, no new iconography. The idle ✓ must not show while reconnecting.

5. **`NotesShell.svelte`** — pass `reconnecting={sync.reconnecting}` to
   SyncStatusBar (and to SettingsScreen → SyncSettingsSection).

6. **`SyncSettingsSection.svelte`** — status line precedence:
   `sync.status` (transient progress) > "Sync failed: …" (escalated error) >
   "Reconnecting…" (quiet state). Plain hint text, not error styling.

## 6. Tests — write these FIRST (AGENTS.md 7.9: failing regression before the fix)

Extend `syncManager.test.ts` (harness already uses `vi.useFakeTimers`; drive time
with `vi.setSystemTime`/`advanceTimersByTime` since the design reads `Date.now()`):

- **The incident, as a regression:** alternate `handleLiveState({live:false,
  status:'reconnecting', message:'connect: error sending request for url (https://…)'})`
  and `autoSyncCallbacks.onSyncError(new TypeError('Load failed'), 'poll')` every
  ~15 s of fake time for 2 minutes → assert **zero toasts**, `syncError === false`,
  `reconnecting === true`. This test MUST fail against current code before the fix.
- Same sequence continued past 3 minutes → exactly **one** toast, `syncError === true`.
- Clean cycle (`handleSyncComplete(emptySummary, 'poll')`) during the quiet window →
  back to healthy, `reconnecting === false`, threshold clock reset (a later failure
  starts a fresh 3-minute window).
- `onSyncError(err, 'manual')` → immediate toast + error, no grace.
- `handleLiveState` with `message: 'auth: HTTP 401 Unauthorized'` → immediate, and
  the surfaced message still contains "auth:"/401 (normalizer left it alone).
- `handleSyncComplete` with `failureMessage` (per-item) → immediate (existing
  behavior, now pinned against accidental widening of the grace).
- Stream/cycle same-outage wording now identical after normalization: run the two
  sources back-to-back past the threshold → still exactly one toast (D1 pinned).
- Existing per-source clearing tests ("a clean poll cannot clear a still-broken
  stream", etc.) must keep passing unmodified.
- `syncErrorMessage.test.ts`: `classifySyncError` cases — transport strings ⇒
  transient; `auth: …`, `HTTP 500 …`, unknown strings ⇒ actionable.

## 7. Spec update (`docs/spec/sync.md`) — do this in the same commit series

- Rewrite the failed-background-sync bullet (~lines 97–107) and the toast bullet
  (~lines 311–322) to state: the recourse principle, the transient "reconnecting"
  state, the 3-minute escalation, the immediate-escalation list (manual, auth,
  HTTP-status, per-item), and that stream messages are normalized through
  `getSyncErrorMessage` before display (no raw URLs/reqwest text in UI).
- Keep (restate, don't delete) the 2026-06-29 lesson: failures are never silently
  swallowed; the quiet state is visible (muted indicator + Settings line) and
  self-escalates.
- Tag the new behavior desktop-only for now and add an inline gap note where the
  spec addresses the native shells, e.g.:
  `> **Gap:** iOS/Android SyncManagers still escalate on the first failure with no
  transient/actionable classification (single lastError bucket); desktop-only as of
  2026-08-24.`
- Keep any remaining `> **Gap:**` notes inline in the owning spec file; list them with
  `rg '> \*\*Gap' docs/spec/`.

## 8. Verification chain

- `pnpm run test:unit` (or the focused vitest run) — new tests red first, then green.
- Follow `src/AGENTS.md`'s chain for UI/Svelte changes (7.1).
- `just check` before the MR.
- Optional live QA (desktop dev build via `/verify` tooling only — M24: resolve any
  QA target through `scripts/qa-target.mjs`, never the installed prod app): dev
  Settings has `DevSyncErrorSettingsSection` to inject failures through the real path.

## 9. Delivery

Branch + GitLab MR (risky-surface convention). Suggested commits:
1. `fix(sync): normalize live-stream error messages before display` — D1 + its
   tests (small, independently shippable, alone kills the toast storm).
2. `feat(sync): quiet reconnecting state with 3-minute escalation` — D2: state
   machine + UI + tests.
3. `docs(spec): sync errors escalate by recourse` — spec rewrite + gap + GAPS.md.

Bodies follow AGENTS.md §5: name the incident (2026-08-24 post-wake tailnet outage,
14 journaled failures, toast storm), the root cause per defect, and a `Verified:`
line with the commands run.

## 10. Guardrails — do NOT

- Do not remove or bypass any existing error surface; the change is *when*, not
  *whether*. A transport outage past the threshold must still go loud with zero
  user action.
- Do not touch `crates/futo-notes-sync`, the Tauri IPC contract, the frontend
  contract types, `BRIDGE_VERSION`, or the `sync:live-state` payload shape — the
  Rust side already emits everything needed. (AGENTS.md §11 ask-first item 6.)
- Do not edit iOS/Android SyncManagers in this pass — spec gap instead (§7).
- Do not duplicate the transport regex anywhere; `syncErrorMessage.ts` is the owner.
- Do not "improve" unrelated wording in sync.md; touch only the reporting lines.
- If the auth-prefix assumption fails (normalizer mangles `auth:` messages), stop
  and rework the classification order rather than special-casing at a call site.
