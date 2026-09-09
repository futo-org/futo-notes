# Sync error escalation — decision and failure lesson

The desktop implementation is present; `docs/spec/sync.md` owns the current
classification, three-minute grace period, per-source recovery, and the remaining
native-shell Gap. The August 24 decision was to classify failures by the action
available to the user, while keeping every failure visible.

## Failure that motivated the change


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

## Durable constraints

- Normalize errors at one owner so polling and live-stream wording cannot alternate
  into repeated toasts for the same outage.
- Background transport failures first show a quiet reconnecting state, then escalate
  if they persist. Manual sync, authentication errors, HTTP responses, and per-item
  completed-cycle failures remain immediately actionable.
- A clean cycle clears only cycle state; a recovered stream clears only stream state.
- Preserve dirty data, retry policy, cursor safety, and the full failure summary.
  Reducing toast noise must never swallow errors or weaken push-first synchronization.
- The native classification/escalation work remains separately scoped in the spec.


## Original plan and evidence

```bash
git show 3b1c43c139181b91b7384b478b5edec454b80190:docs/plan/sync-error-escalation.md
```
