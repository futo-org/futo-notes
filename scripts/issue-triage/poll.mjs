/**
 * Tier 1 of the GitHub issue triage system: poll the futo-org/futo-notes issue
 * mirror, post every new issue to Zulip #futo-notes-alerts, and queue bugs for
 * an autonomous reproduction attempt (tier 2, runTriage.mjs).
 *
 * This tier is deliberately boring and LLM-free so a flaky agent run can never
 * lose an issue notification. A systemd user timer runs it every 15 minutes;
 * because it is poll-based, downtime only delays notifications, never drops
 * them (docs/plan/github-issue-triage.md, "Architecture: two tiers").
 *
 * Exit codes: 0 on success, 1 on any GitHub/Zulip failure — the systemd unit's
 * failure state is the alarm (M11: never swallow an error to look healthy).
 *
 * Usage:
 *   node scripts/issue-triage/poll.mjs            # live: post + record
 *   node scripts/issue-triage/poll.mjs --dry-run  # print what it would post
 */
import { pathToFileURL } from 'node:url';

import { classifyIssue } from './classifyIssue.mjs';
import { fetchIssuesSince } from './githubIssues.mjs';
import { loadState, nextWatermark, saveState } from './triageState.mjs';
import { formatAlert, postAlert, topicForIssue } from './zulipAlerts.mjs';

const REPO = 'futo-org/futo-notes';

/**
 * Post one new issue and record it in state before returning. A bug is left at
 * status "queued" so tier 2 can pick it up; a feature/other stops at "posted".
 *
 * Ordering matters for idempotency: post first, then persist. The post is the
 * only externally visible action, and persisting immediately after (per issue,
 * not batched) keeps a crash's blast radius to at most one duplicate message.
 *
 * @param {{ issue: object, state: object, dryRun: boolean }} params
 * @returns {Promise<string>} the tier-1 classification kind
 */
async function processIssue({ issue, state, dryRun }) {
  const classification = classifyIssue(issue);
  const topic = topicForIssue(issue.number, issue.title);
  const content = formatAlert({ issue, classification });

  if (dryRun) {
    process.stdout.write(
      `\n── would post → #${issue.number} [${classification.kind}] ──\n` +
        `topic: ${topic}\n${content}\n`,
    );
    return classification.kind;
  }

  const posted = await postAlert({ topic, content });

  state.issues[issue.number] = {
    status: classification.kind === 'bug' ? 'queued' : 'posted',
    title: issue.title,
    url: issue.url,
    author: issue.author,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    classifiedAs: classification.kind,
    zulipTopic: topic,
    zulipMessageId: posted.id,
    mrUrl: null,
  };
  saveState(state);
  return classification.kind;
}

/**
 * Orchestrate one poll cycle: read state, fetch new issues, post each, advance
 * the watermark.
 * @param {{ dryRun: boolean }} options
 * @returns {Promise<{ posted: number, queued: number }>}
 */
export async function runPoll({ dryRun }) {
  const token = process.env.GITHUB_PAT;

  const state = loadState();
  const issues = await fetchIssuesSince({ repo: REPO, since: state.watermark, token });

  // Only issues never seen before, oldest first so topics read in order.
  const fresh = issues
    .filter((issue) => !state.issues[issue.number])
    .sort((a, b) => a.number - b.number);

  let queued = 0;
  for (const issue of fresh) {
    const kind = await processIssue({ issue, state, dryRun });
    if (kind === 'bug') queued += 1;
  }

  // Advance the watermark only on a live run; a dry run must not move it, or it
  // would silently mark the backlog as processed without posting anything.
  if (!dryRun && fresh.length > 0) {
    state.watermark = nextWatermark(state.watermark, issues);
    saveState(state);
  }

  return { posted: fresh.length, queued };
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');

  try {
    const { posted, queued } = await runPoll({ dryRun });
    const mode = dryRun ? '[dry-run] ' : '';
    process.stdout.write(
      `${mode}poll complete: ${posted} new issue(s), ${queued} queued as bug(s)\n`,
    );
  } catch (error) {
    process.stderr.write(`poll failed: ${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
