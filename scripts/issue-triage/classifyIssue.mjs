/**
 * Classify a GitHub issue as a bug, a feature request, or other — the tier-1
 * guess that decides what the Zulip post says and whether the issue is queued
 * for an autonomous reproduction attempt (tier 2).
 *
 * This is a deliberately conservative, pure heuristic over the title and body.
 * The rule (docs/plan/github-issue-triage.md, "Classification"): when unsure,
 * classify DOWN, never up — a misfiled feature request must never trigger an
 * agent run. Tier 2's agent re-classifies before doing anything expensive, so a
 * missed bug here only delays triage; a false "bug" here wastes a repro run.
 */

/** The community consistently prefixes feature requests this way. */
const FEATURE_REQUEST_TITLE = /^\s*feature request\b/i;

/**
 * Words that signal wrong behavior of an existing feature, a crash, or visual
 * breakage. Matched as whole words (case-insensitive) so "error" does not fire
 * on "terror" and "bug" does not fire on "debugging".
 */
const BUG_TERMS = [
  'bug',
  'crash',
  'crashes',
  'crashing',
  'freeze',
  'freezes',
  'hang',
  'hangs',
  'broken',
  'glitch',
  'regression',
  'unresponsive',
  'error',
  'fails',
  'failing',
  'incorrect',
  'wrong',
  'unreadable',
  'invisible',
];

/**
 * Multi-word bug phrases. Kept separate from BUG_TERMS because they are
 * matched as substrings, not word-boundary tokens.
 */
const BUG_PHRASES = [
  "doesn't work",
  'does not work',
  'not working',
  "can't see",
  'cannot see',
  'black text',
  'white text',
  'black on black',
  'white on white',
  'no longer works',
  'stopped working',
];

const BUG_TERM_RE = new RegExp(`\\b(?:${BUG_TERMS.join('|')})\\b`, 'i');

/**
 * @typedef {'bug' | 'feature' | 'other'} IssueKind
 * @typedef {{ kind: IssueKind, reason: string }} Classification
 */

/**
 * @param {{ title?: string, body?: string }} issue
 * @returns {Classification}
 */
export function classifyIssue({ title = '', body = '' }) {
  // The explicit community prefix is the strongest signal and wins outright,
  // even when the body mentions a crash ("the app crashes without this
  // feature") — that is still a feature request, not a bug to reproduce.
  if (FEATURE_REQUEST_TITLE.test(title)) {
    return { kind: 'feature', reason: 'title prefixed "Feature Request"' };
  }

  const haystack = `${title}\n${body}`;

  const phrase = BUG_PHRASES.find((p) => haystack.toLowerCase().includes(p));
  if (phrase) {
    return { kind: 'bug', reason: `mentions "${phrase}"` };
  }

  const term = haystack.match(BUG_TERM_RE);
  if (term) {
    return { kind: 'bug', reason: `mentions "${term[0]}"` };
  }

  // No feature-request prefix and no bug signal: could be an un-prefixed
  // feature idea, a question, or support. Classify down to "other" so it is
  // posted to Zulip for a human, never sent to an agent.
  return { kind: 'other', reason: 'no bug signal and no feature-request prefix' };
}
