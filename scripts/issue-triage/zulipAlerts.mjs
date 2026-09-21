/**
 * Zulip integration for the triage poller: post one message per new issue to
 * the #futo-notes-alerts channel, one topic per issue so every follow-up
 * (repro result, MR link) stays threaded (docs/plan/github-issue-triage.md).
 *
 * Posting here is the authorized output of this system. Credentials come from
 * the environment (ZULIP_TRIAGE_BOT_EMAIL / ZULIP_TRIAGE_BOT_KEY), supplied by
 * ~/.zshrc interactively and by the systemd EnvironmentFile under the timer.
 *
 * The same channel also carries this system's own health: `formatFailureAlert`
 * and `formatRecoveryAlert` report the poller being broken and fixed, because
 * an alert channel that cannot say "I am not delivering" let a 401 go unnoticed
 * for 11 days (see healthState.mjs).
 *
 * `topicForIssue` and the `format*` functions are pure (testable without a
 * network); `postAlert` is the I/O wrapper.
 */
import { outageDuration } from './healthState.mjs';

const ZULIP_SITE = 'https://zulip.futo.org';
const ALERTS_CHANNEL = 'futo-notes-alerts';

/**
 * One stable topic for every poller-health message, so an outage and its
 * recovery thread together and the operator can follow (or mute) exactly this
 * one thing without touching the per-issue topics.
 */
export const HEALTH_TOPIC = 'poller health';

/** Zulip truncates topics beyond this many characters. */
const MAX_TOPIC_LENGTH = 60;

/** How many lines of the issue body to include in the alert. */
const BODY_PREVIEW_LINES = 40;

/**
 * Build the per-issue topic `gh#<number>: <title>`, trimming the title so the
 * whole topic fits Zulip's limit (the number must always survive).
 * @param {number} number
 * @param {string} title
 * @returns {string}
 */
export function topicForIssue(number, title) {
  const prefix = `gh#${number}: `;
  const room = MAX_TOPIC_LENGTH - prefix.length;
  const trimmed = title.length > room ? `${title.slice(0, room - 1)}…` : title;
  return `${prefix}${trimmed}`;
}

/**
 * Compose the alert body: attribution, link, the tier-1 classification guess,
 * and a bounded preview of the issue text. The issue body is quoted so its
 * markdown/attacker-controlled content renders as a block, not as directives.
 * @param {{
 *   issue: { number: number, title: string, body: string, author: string, createdAt: string, url: string },
 *   classification: { kind: string, reason: string }
 * }} params
 * @returns {string}
 */
export function formatAlert({ issue, classification }) {
  const preview = (issue.body || '_(no description)_')
    .split('\n')
    .slice(0, BODY_PREVIEW_LINES)
    .map((line) => `> ${line}`)
    .join('\n');

  const truncated = (issue.body || '').split('\n').length > BODY_PREVIEW_LINES ? '\n> …' : '';

  return [
    `**[gh#${issue.number}: ${issue.title}](${issue.url})**`,
    `Opened by \`${issue.author}\` on ${issue.createdAt.slice(0, 10)}`,
    `Tier-1 classification: **${classification.kind}** (${classification.reason})`,
    '',
    preview + truncated,
  ].join('\n');
}

/**
 * The message that says this channel is broken. Names the failing unit and the
 * exact command that shows the full error, because the reason recorded by the
 * poller is truncated and a hard crash records none at all.
 *
 * @param {{
 *   error: string | null,
 *   sinceIso: string | null,
 *   nowMs: number,
 *   alertCount: number,
 *   durationImpl?: (fromIso: string | null, nowMs: number) => string
 * }} params
 * @returns {string}
 */
export function formatFailureAlert({
  error,
  sinceIso,
  nowMs,
  alertCount,
  durationImpl = outageDuration,
}) {
  const first = alertCount === 0;
  const headline = first
    ? '**:warning: The issue poller is failing — new GitHub issues are NOT reaching this channel.**'
    : `**:warning: The issue poller is still failing** (failing for ${durationImpl(sinceIso, nowMs)}).`;

  return [
    headline,
    `Failing since: ${sinceIso ?? 'unknown'}`,
    '',
    'Reason:',
    `> ${(error ?? 'the unit failed without recording a reason (a crash before the error handler)').replace(/\n/g, '\n> ')}`,
    '',
    'Nothing is lost — the poller is watermark-based, so every missed issue posts',
    'on the first successful run. Full error and history:',
    '```',
    'journalctl --user -u futo-notes-issue-triage.service -n 50',
    '```',
  ].join('\n');
}

/**
 * The all-clear, posted by the first successful poll after an outage. States
 * how long it was down and how many issues the catch-up run posted, so the
 * thread answers "did I miss anything?" without a state-file read.
 *
 * @param {{
 *   sinceIso: string | null,
 *   nowMs: number,
 *   postedCount: number,
 *   durationImpl?: (fromIso: string | null, nowMs: number) => string
 * }} params
 * @returns {string}
 */
export function formatRecoveryAlert({
  sinceIso,
  nowMs,
  postedCount,
  durationImpl = outageDuration,
}) {
  const caught =
    postedCount === 0
      ? 'No issues were missed.'
      : `Caught up ${postedCount} issue${postedCount === 1 ? '' : 's'}, posted above.`;

  return [
    '**:check: The issue poller is working again.**',
    `It was failing for ${durationImpl(sinceIso, nowMs)} (since ${sinceIso ?? 'unknown'}).`,
    caught,
  ].join('\n');
}

/**
 * Post a message to a topic in #futo-notes-alerts. Throws on any non-success
 * so the caller (and the systemd unit) treats a failed post as a hard failure
 * rather than silently continuing (M11: no silent green).
 * @param {{ topic: string, content: string, fetchImpl?: typeof fetch }} params
 * @returns {Promise<{ id: number }>}
 */
export async function postAlert({ topic, content, fetchImpl = fetch }) {
  const email = process.env.ZULIP_TRIAGE_BOT_EMAIL;
  const key = process.env.ZULIP_TRIAGE_BOT_KEY;
  if (!email || !key) {
    throw new Error('missing ZULIP_TRIAGE_BOT_EMAIL / ZULIP_TRIAGE_BOT_KEY');
  }

  const body = new URLSearchParams({
    type: 'channel',
    to: ALERTS_CHANNEL,
    topic,
    content,
  });

  const response = await fetchImpl(`${ZULIP_SITE}/api/v1/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${key}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.result !== 'success') {
    throw new Error(`Zulip post failed (${response.status}): ${result.msg ?? 'unknown error'}`);
  }

  return { id: result.id };
}
