/**
 * The MR factory's decisions, kept pure so they can be tested without GitLab,
 * Zulip, or an agent: which MRs a sweep picks up, what counts as a valid agent
 * result, and the exact text of every message the factory sends.
 *
 * The rules themselves were settled with Justin on 2026-10-26 (README.md,
 * "What it does"); this file is where they are enforced.
 */

/** GitLab username → Zulip user id. Only these authors' MRs are touched. */
export const AUTHORS = Object.freeze({ justin: 1557, mason: 3633 });

/**
 * Authors whose MRs wait for a named approver to press Approve in GitLab
 * before the factory touches them (Justin, 2026-10-26: "for now").
 */
export const APPROVER_FOR = Object.freeze({ mason: 'justin' });

/** Bug reports about the factory itself go to the operator. */
export const OPERATOR_ZULIP_ID = AUTHORS.justin;

export const HOLD_LABEL = 'factory::hold';
export const NEEDS_HUMAN_LABEL = 'factory::needs-human';
export const MAX_MRS_PER_SWEEP = 5;
export const TARGET_BRANCH = 'main';

/** While the factory stays broken, re-alert at most this often. */
export const ALERT_THROTTLE_MS = 6 * 60 * 60 * 1000;

const VERDICTS = new Set(['merged', 'no_ship', 'needs_merge']);
const SHA = /^[0-9a-f]{40}$/;

/**
 * Pick the MRs this sweep runs `/mr-qa` on: open, non-draft, targeting main,
 * written by a known author, not held, and whose head commit has no verdict
 * yet. Oldest first, capped.
 *
 * A recorded verdict is keyed by head SHA, so a new push makes the MR
 * eligible again — that is how a `factory::needs-human` MR re-enters.
 *
 * An author listed in APPROVER_FOR also needs that approver among the MR's
 * approvers. GitLab's own `approved` flag is no use here: the project
 * requires zero approvals, so it reads true for every MR.
 *
 * @param {Array<object>} openMrs GitLab merge request objects
 * @param {{ mrs: Record<string, { sha: string }> }} state
 * @param {Map<number, string[]>} [approvers] usernames who approved, per iid
 * @param {number} [max]
 */
export function selectMrs(openMrs, state, approvers = new Map(), max = MAX_MRS_PER_SWEEP) {
  return openMrs
    .filter((mr) => isCandidate(mr) && state.mrs[mr.iid]?.sha !== mr.sha)
    .filter((mr) => {
      const approver = APPROVER_FOR[mr.author.username];
      return !approver || (approvers.get(mr.iid) ?? []).includes(approver);
    })
    .sort((a, b) => a.iid - b.iid)
    .slice(0, max);
}

/** Open, non-draft, into main, by a known author, not held. */
export function isCandidate(mr) {
  return (
    !mr.draft &&
    mr.target_branch === TARGET_BRANCH &&
    Object.hasOwn(AUTHORS, mr.author?.username ?? '') &&
    !(mr.labels ?? []).includes(HOLD_LABEL)
  );
}

/** Which MRs need their approvers looked up before selection. */
export function needsApproval(mr) {
  return isCandidate(mr) && Object.hasOwn(APPROVER_FOR, mr.author.username);
}

/**
 * Validate the agent-owned result file against the MRs it was given.
 *
 * Returns null when the file is not a result at all. Otherwise every selected
 * MR lands in exactly one of `verdicts` or `missing`: an entry that is
 * malformed, duplicated, or about an MR the agent was not given is not trusted.
 *
 * @param {string} raw
 * @param {number[]} selectedIids
 * @returns {null | {
 *   verdicts: Map<number, { verdict: string, comment: string | null }>,
 *   missing: number[],
 *   problems: string[],
 *   summary: string
 * }}
 */
export function parseResult(raw, selectedIids) {
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!result || typeof result !== 'object' || !Array.isArray(result.mrs)) return null;

  const wanted = new Set(selectedIids);
  const seen = new Map();
  const duplicated = new Set();
  for (const entry of result.mrs) {
    if (!entry || !wanted.has(entry.iid)) continue;
    if (seen.has(entry.iid)) duplicated.add(entry.iid);
    seen.set(entry.iid, entry);
  }

  const verdicts = new Map();
  for (const [iid, entry] of seen) {
    if (duplicated.has(iid) || !VERDICTS.has(entry.verdict)) continue;
    const needsComment = entry.verdict !== 'merged';
    const hasComment = typeof entry.comment === 'string' && entry.comment.trim() !== '';
    if (needsComment !== hasComment) continue;
    verdicts.set(iid, { verdict: entry.verdict, comment: needsComment ? entry.comment : null });
  }

  const problems = Array.isArray(result.problems)
    ? result.problems.filter((p) => typeof p === 'string' && p.trim() !== '')
    : [];

  return {
    verdicts,
    missing: selectedIids.filter((iid) => !verdicts.has(iid)),
    problems,
    summary: typeof result.summary === 'string' ? result.summary : '',
  };
}

export function isSha(value) {
  return typeof value === 'string' && SHA.test(value);
}

/** The MR comment: the agent's text plus which commit it is about. */
export function formatComment(comment, sha) {
  return `${comment.trim()}\n\n---\n_MR factory · head \`${sha.slice(0, 8)}\`_`;
}

/** The author's DM. Justin asked for exactly this text. */
export function formatCommentDm({ iid, webUrl, noteId }) {
  return `left a comment on [!${iid}](${webUrl}#note_${noteId})`;
}

/**
 * @param {{ error: string | null, sinceIso: string | null, alertCount: number }} params
 */
export function formatFailureDm({ error, sinceIso, alertCount }) {
  return [
    alertCount === 0
      ? "**The MR factory is broken.** Non-draft MRs are not being QA'd or merged until this is fixed."
      : `**The MR factory is still broken** (since ${sinceIso ?? 'unknown'}).`,
    '',
    '```',
    error ?? 'the unit failed without recording a reason (a crash before the error handler)',
    '```',
    '',
    '`journalctl --user -u futo-notes-mr-factory.service -n 100`',
  ].join('\n');
}

export function formatRecoveryDm({ sinceIso }) {
  return `**The MR factory is working again** (it was broken since ${sinceIso ?? 'unknown'}).`;
}

/** Should this failure DM the operator? First failure always; then once per window. */
export function shouldAlert(health, nowMs, throttleMs = ALERT_THROTTLE_MS) {
  const last = Date.parse(health.lastAlertAt ?? '');
  return !Number.isFinite(last) || nowMs - last >= throttleMs;
}
