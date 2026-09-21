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
 * Exit codes: 0 on success, 1 on any GitHub/Zulip failure. The failure is both
 * a red systemd unit and — via the unit's OnFailure= handler, alertFailure.mjs
 * — a Zulip message, because a red unit alone went unnoticed for 11 days when
 * the old GitHub PAT expired (M11: never swallow an error to look healthy).
 * This script's success path owns the matching all-clear.
 *
 * Usage:
 *   node scripts/issue-triage/poll.mjs            # live: post + record
 *   node scripts/issue-triage/poll.mjs --dry-run  # print what it would post
 */
import { pathToFileURL } from 'node:url';

import { classifyIssue } from './classifyIssue.mjs';
import { fetchIssuesSince } from './githubIssues.mjs';
import { endOutage, recordFailureReason } from './healthState.mjs';
import { loadState, nextWatermark, stateDir, updateState } from './triageState.mjs';
import {
  HEALTH_TOPIC,
  formatAlert,
  formatRecoveryAlert,
  postAlert,
  topicForIssue,
} from './zulipAlerts.mjs';

const REPO = 'futo-org/futo-notes';

/**
 * Post one new issue and record it in state before returning. A bug is left at
 * status "queued" so tier 2 can pick it up; a feature/other stops at "posted".
 *
 * Ordering matters for idempotency: post first, then persist. The post is the
 * only externally visible action, and persisting immediately after (per issue,
 * not batched) keeps a crash's blast radius to at most one duplicate message.
 *
 * @param {{
 *   issue: object,
 *   dryRun: boolean,
 *   stateDirectory: string,
 *   postAlertImpl: typeof postAlert
 * }} params
 * @returns {Promise<string>} the tier-1 classification kind
 */
async function processIssue({ issue, dryRun, stateDirectory, postAlertImpl }) {
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

  const posted = await postAlertImpl({ topic, content });

  await updateState((state) => {
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
  }, stateDirectory);
  return classification.kind;
}

/**
 * Orchestrate one poll cycle: read state, fetch new issues, post each, advance
 * the watermark.
 * @param {{ dryRun: boolean, stateDirectory?: string, dependencies?: object }} options
 * @returns {Promise<{ posted: number, queued: number }>}
 */
export async function runPoll({ dryRun, stateDirectory = stateDir(), dependencies = {} }) {
  const fetchIssuesSinceImpl = dependencies.fetchIssuesSince ?? fetchIssuesSince;
  const postAlertImpl = dependencies.postAlert ?? postAlert;

  const state = loadState(stateDirectory);
  const issues = await fetchIssuesSinceImpl({ repo: REPO, since: state.watermark });

  // Only issues never seen before, oldest first so topics read in order.
  const fresh = issues
    .filter((issue) => !state.issues[issue.number])
    .sort((a, b) => a.number - b.number);

  let queued = 0;
  for (const issue of fresh) {
    const kind = await processIssue({ issue, dryRun, stateDirectory, postAlertImpl });
    if (kind === 'bug') queued += 1;
  }

  // Advance the watermark only on a live run; a dry run must not move it, or it
  // would silently mark the backlog as processed without posting anything.
  if (!dryRun && fresh.length > 0) {
    await updateState((latestState) => {
      latestState.watermark = nextWatermark(latestState.watermark, issues);
    }, stateDirectory);
  }

  // A recovery is only observable by the run that succeeds, so the all-clear
  // belongs here rather than in the failure handler. Posted after the caught-up
  // issues so the channel reads in order, and last so a Zulip failure here
  // cannot cost an issue notification. A dry run must not clear the outage.
  const recovered = dryRun ? null : endOutage(stateDirectory);
  if (recovered) {
    await postAlertImpl({
      topic: HEALTH_TOPIC,
      content: formatRecoveryAlert({
        sinceIso: recovered.firstFailureAt,
        nowMs: Date.now(),
        postedCount: fresh.length,
      }),
    });
  }

  return { posted: fresh.length, queued, recovered: Boolean(recovered) };
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');

  try {
    const { posted, queued, recovered } = await runPoll({ dryRun });
    const mode = dryRun ? '[dry-run] ' : '';
    process.stdout.write(
      `${mode}poll complete: ${posted} new issue(s), ${queued} queued as bug(s)` +
        `${recovered ? ' — recovered from an outage' : ''}\n`,
    );
  } catch (error) {
    // Record the reason for the OnFailure= handler to quote, then fail red.
    // Best-effort: a broken state directory must not replace the real error.
    if (!dryRun) {
      try {
        recordFailureReason(error.message);
      } catch {
        /* keep the original failure as the reported one */
      }
    }
    process.stderr.write(`poll failed: ${error.message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
