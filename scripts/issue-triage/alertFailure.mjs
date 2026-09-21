/**
 * The systemd `OnFailure=` handler for the issue poller: tell
 * #futo-notes-alerts that the alert channel itself is broken.
 *
 * Why this exists: the poller's GitHub PAT expired on 2026-08-22, every
 * 15-minute run failed with 401, and nobody found out for 11 days because the
 * only alarm was a red systemd unit nobody was watching. Exiting non-zero is
 * necessary but not sufficient — the failure has to reach a human.
 *
 * Two rules shape this script:
 *
 *  - It owns opening the outage, not poll.mjs. Being invoked at all IS the
 *    failure signal, so a crash that never reaches poll.mjs's error handler
 *    (no node, OOM, unreadable EnvironmentFile) still alerts — just with a
 *    generic reason instead of the recorded one.
 *  - It is throttled (healthState.mjs). A 15-minute timer failing for a month
 *    is ~2,900 runs; the operator gets one message per 6-hour window.
 *
 * The unit that runs this deliberately has no OnFailure= of its own: when Zulip
 * is the thing that is down, the alert cannot post, and the correct outcome is
 * one red unit in the journal rather than a retry loop.
 *
 * Exit codes: 0 posted or deliberately throttled, 1 the alert could not be sent.
 */
import { pathToFileURL } from 'node:url';

import { beginOutage, loadHealth, markAlerted, saveHealth, shouldAlert } from './healthState.mjs';
import { stateDir } from './triageState.mjs';
import { HEALTH_TOPIC, formatFailureAlert, postAlert } from './zulipAlerts.mjs';

/**
 * @param {{
 *   nowMs?: number,
 *   stateDirectory?: string,
 *   dependencies?: { postAlert?: typeof postAlert }
 * }} [options]
 * @returns {Promise<{ alerted: boolean, throttled: boolean }>}
 */
export async function reportFailure({
  nowMs = Date.now(),
  stateDirectory = stateDir(),
  dependencies = {},
} = {}) {
  const postAlertImpl = dependencies.postAlert ?? postAlert;
  const opened = beginOutage(loadHealth(stateDirectory), nowMs);

  if (!shouldAlert(opened, nowMs)) {
    // Persist the still-open outage even when staying quiet, so firstFailureAt
    // survives and the eventual recovery message can measure the real duration.
    saveHealth(opened, stateDirectory);
    return { alerted: false, throttled: true };
  }

  // Post before persisting the alert stamp: a crash in between costs a repeat
  // message, whereas the reverse order could swallow the only alarm.
  await postAlertImpl({
    topic: HEALTH_TOPIC,
    content: formatFailureAlert({
      error: opened.lastError,
      sinceIso: opened.firstFailureAt,
      nowMs,
      alertCount: opened.alertCount ?? 0,
    }),
  });

  saveHealth(markAlerted(opened, nowMs), stateDirectory);
  return { alerted: true, throttled: false };
}

async function main() {
  try {
    const { alerted, throttled } = await reportFailure();
    process.stdout.write(
      throttled
        ? 'poll failure recorded; Zulip alert throttled (already reported this outage)\n'
        : `poll failure reported to Zulip: ${alerted}\n`,
    );
  } catch (error) {
    process.stderr.write(`could not report poll failure: ${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
