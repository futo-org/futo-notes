/**
 * The systemd `OnFailure=` handler for the MR factory: DM the operator that a
 * part of it is broken. Justin's rule (2026-10-26): any bug in any part reaches
 * him as a DM.
 *
 * Being invoked at all is the failure signal, so a crash that never reached
 * sweep.mjs's error handler (missing node, a deleted checkout, an unreadable
 * EnvironmentFile) still alerts, with a generic reason. An hourly timer failing
 * overnight is throttled to one DM per 6 hours (rules.mjs ALERT_THROTTLE_MS);
 * the first successful sweep sends the all-clear.
 *
 * The unit running this has no OnFailure= of its own: when Zulip is what is
 * down, this cannot post either, and one red unit in the journal is the right
 * outcome rather than a loop.
 */
import { pathToFileURL } from 'node:url';

import { OPERATOR_ZULIP_ID, formatFailureDm, shouldAlert } from './rules.mjs';
import { loadHealth, saveHealth, sendDm, stateDir } from './services.mjs';

export async function reportFailure({ nowMs = Date.now(), dir = stateDir() } = {}) {
  const loaded = loadHealth(dir);
  const health = {
    ...loaded,
    failing: true,
    firstFailureAt:
      loaded.failing && loaded.firstFailureAt
        ? loaded.firstFailureAt
        : new Date(nowMs).toISOString(),
  };
  if (!shouldAlert(health, nowMs)) {
    saveHealth(health, dir);
    return { alerted: false };
  }
  // Post before stamping: a crash in between repeats a DM instead of losing it.
  await sendDm(
    OPERATOR_ZULIP_ID,
    formatFailureDm({
      error: health.lastError ?? null,
      sinceIso: health.firstFailureAt,
      alertCount: health.alertCount ?? 0,
    }),
  );
  saveHealth(
    {
      ...health,
      lastAlertAt: new Date(nowMs).toISOString(),
      alertCount: (health.alertCount ?? 0) + 1,
    },
    dir,
  );
  return { alerted: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reportFailure()
    .then(({ alerted }) =>
      process.stdout.write(alerted ? 'failure DM sent\n' : 'failure recorded; DM throttled\n'),
    )
    .catch((error) => {
      process.stderr.write(`could not report the factory failure: ${error.message}\n`);
      process.exit(1);
    });
}
