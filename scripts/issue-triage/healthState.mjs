/**
 * Poller health: whether the poll is currently failing, and when the operator
 * was last told about it.
 *
 * A failed systemd unit is only an alarm if somebody is looking at systemd. The
 * GitHub PAT this poller carried expired on 2026-08-22; every 15-minute run
 * failed with 401 for 11 days and nine issues never reached
 * #futo-notes-alerts, because nothing told anyone. This module is what lets the
 * alert channel report its own breakage — while keeping an outage to one
 * message per throttle window instead of the ~1,000 a 15-minute timer would
 * otherwise produce.
 *
 * It lives in its own file, never inside state.json: nothing about alerting may
 * put the issue map that prevents duplicate posts at risk.
 *
 * Shape (health.json):
 *   {
 *     failing: boolean,           // an outage is open right now
 *     firstFailureAt: string|null,// ISO, when the current outage started
 *     lastAlertAt: string|null,   // ISO, last Zulip failure message
 *     alertCount: number,         // messages sent for the current outage
 *     lastError: string|null,     // most recent reason, recorded by poll.mjs
 *     lastErrorAt: string|null
 *   }
 *
 * The predicates are pure and the I/O is a thin wrapper, matching the rest of
 * this directory.
 */
import { join } from 'node:path';

import { readJsonOr, writeJsonAtomic } from './jsonFile.mjs';
import { stateDir } from './triageState.mjs';

/**
 * While an outage is open, re-alert at most this often. Long enough that a
 * multi-day credential/API outage costs a handful of messages, short enough
 * that a failure starting overnight is still on the channel by morning.
 */
export const ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000;

const EMPTY_HEALTH = {
  failing: false,
  firstFailureAt: null,
  lastAlertAt: null,
  alertCount: 0,
  lastError: null,
  lastErrorAt: null,
};

/** @typedef {typeof EMPTY_HEALTH} Health */

function healthFilePath(dir) {
  return join(dir, 'health.json');
}

/**
 * @param {string} [dir]
 * @returns {Health}
 */
export function loadHealth(dir = stateDir()) {
  return { ...EMPTY_HEALTH, ...readJsonOr(healthFilePath(dir), {}) };
}

/**
 * @param {Health} health
 * @param {string} [dir]
 */
export function saveHealth(health, dir = stateDir()) {
  writeJsonAtomic(healthFilePath(dir), health);
}

/**
 * Should this failure produce a Zulip message? The first failure of an outage
 * always does; after that, only once per throttle window. Pure.
 *
 * @param {Health} health
 * @param {number} nowMs
 * @param {number} [throttleMs]
 * @returns {boolean}
 */
export function shouldAlert(health, nowMs, throttleMs = ALERT_THROTTLE_MS) {
  if (!health.lastAlertAt) return true;
  const last = Date.parse(health.lastAlertAt);
  // An unparseable timestamp must not silence the alarm.
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= throttleMs;
}

/**
 * Open an outage (or continue the one already open), leaving `firstFailureAt`
 * pinned to when it actually started. Pure.
 *
 * @param {Health} health
 * @param {number} nowMs
 * @returns {Health}
 */
export function beginOutage(health, nowMs) {
  return {
    ...health,
    failing: true,
    firstFailureAt:
      health.failing && health.firstFailureAt
        ? health.firstFailureAt
        : new Date(nowMs).toISOString(),
  };
}

/**
 * Stamp that the operator has now been told. Pure.
 * @param {Health} health
 * @param {number} nowMs
 * @returns {Health}
 */
export function markAlerted(health, nowMs) {
  return {
    ...health,
    lastAlertAt: new Date(nowMs).toISOString(),
    alertCount: (health.alertCount ?? 0) + 1,
  };
}

/**
 * Record why the run failed, without deciding anything about alerting. Called
 * by poll.mjs on its way to exit 1, so the alert can name the real cause; a
 * crash that never reaches this still alerts, just less specifically.
 *
 * @param {string} message
 * @param {string} [dir]
 */
export function recordFailureReason(message, dir = stateDir()) {
  const health = loadHealth(dir);
  saveHealth({ ...health, lastError: message, lastErrorAt: new Date().toISOString() }, dir);
}

/**
 * Close an open outage. Returns the outage that was open (for the recovery
 * message) or null when the poller was already healthy — recovery is only
 * observable by the run that succeeds.
 *
 * @param {string} [dir]
 * @returns {Health | null}
 */
export function endOutage(dir = stateDir()) {
  const health = loadHealth(dir);
  if (!health.failing) return null;
  saveHealth({ ...EMPTY_HEALTH }, dir);
  return health;
}

/**
 * Human-readable outage duration ("3 days", "20 hours", "45 minutes"). Pure.
 * @param {string | null} fromIso
 * @param {number} nowMs
 * @returns {string}
 */
export function outageDuration(fromIso, nowMs) {
  const from = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(from)) return 'an unknown period';
  const minutes = Math.max(0, Math.round((nowMs - from) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}
