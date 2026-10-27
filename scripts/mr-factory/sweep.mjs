#!/usr/bin/env node
/**
 * The MR factory: an hourly, headless `/mr-qa` pass over every non-draft MR
 * that has not been judged at its current head commit. SHIPs are merged by the
 * agent, exactly as `/mr-qa` does interactively; nobody hears about those. An
 * MR that is still NO SHIP after one fix attempt, or that passed but sits on
 * `/mr-qa`'s closed hold list, gets one comment, the `factory::needs-human`
 * label, and a Zulip DM to its author: "left a comment on [!N](link)".
 *
 * This launcher is the deterministic half, in the shape of
 * scripts/papercut-sweep/sweep.mjs: it picks the MRs, owns the checkout, the
 * timebox, the result contract, the comment, the label, the DM, and the state
 * that keeps a commit from being judged twice. The agent runs `/mr-qa` and
 * writes a JSON result. Any part breaking — GitLab, Zulip, the agent, a
 * problem that kept the agent from a verdict — exits non-zero, and the unit's
 * OnFailure= handler (alertFailure.mjs) DMs the operator. Friction the agent
 * got around is filed as papercuts instead (factory-prompt.md).
 *
 * Mason's MRs also wait for Justin to press Approve in GitLab (rules.mjs
 * APPROVER_FOR).
 *
 * Authors are the two maintainers only (rules.mjs AUTHORS), so the agent runs
 * with the operator's normal environment like the other timers on this
 * machine: `/mr-qa` needs the device pool, the Mac over Tailscale, and the
 * local Codex login. Only the Zulip bot key is withheld from it.
 *
 *   node scripts/mr-factory/sweep.mjs             # a real sweep
 *   node scripts/mr-factory/sweep.mjs --dry-run   # what it would pick, and the prompt
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  AUTHORS,
  NEEDS_HUMAN_LABEL,
  OPERATOR_ZULIP_ID,
  formatComment,
  formatCommentDm,
  formatRecoveryDm,
  needsApproval,
  parseResult,
  selectMrs,
} from './rules.mjs';
import {
  getApprovers,
  getMr,
  listOpenMrs,
  loadHealth,
  loadState,
  postNote,
  saveHealth,
  saveState,
  sendDm,
  stateDir,
  updateLabels,
} from './services.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_PROMPT_FILE = path.join(HERE, 'factory-prompt.md');
const DEFAULT_REPO_DIR = path.resolve(HERE, '..', '..');

/** Five MRs with device legs and a fix round each; the unit allows 4h. */
const TIMEBOX_MS = 3.5 * 60 * 60 * 1000;

/**
 * A manual run must not overlap the timer's (systemd already stops the timer
 * overlapping itself). A lock left by a dead process is taken over.
 */
function acquireLock(dir) {
  const lockFile = path.join(dir, 'sweep.lock');
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(lockFile, { force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const holder = Number(fs.readFileSync(lockFile, 'utf8'));
      try {
        process.kill(holder, 0);
        return null;
      } catch {
        fs.rmSync(lockFile, { force: true });
      }
    }
  }
  return null;
}

function runGit(args, cwd) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`);
  }
  return result.stdout;
}

/**
 * The agent's checkout: one persistent worktree, reset to a fresh origin/main
 * every sweep. Persistent so node_modules stays warm; detached and owned only
 * by the factory, so the reset can never discard anyone's work. `/mr-qa`
 * creates and deletes its per-MR worktrees under it.
 */
function prepareCheckout({ dir, repoDirectory }) {
  const checkout = path.join(dir, 'checkout');
  runGit(['fetch', 'origin', 'main'], repoDirectory);
  if (fs.existsSync(checkout)) {
    runGit(['checkout', '--detach', '--force', 'origin/main'], checkout);
  } else {
    runGit(['worktree', 'add', '--detach', checkout, 'origin/main'], repoDirectory);
  }
  const install = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd: checkout,
    stdio: 'inherit',
  });
  if (install.status !== 0) throw new Error('pnpm install failed in the factory checkout');
  return checkout;
}

function buildTaskPrompt({ mrs, resultFile }) {
  const rows = mrs.map(
    (mr) =>
      `- !${mr.iid} "${mr.title}" by ${mr.author.username} — branch \`${mr.source_branch}\`, head \`${mr.sha}\` — ${mr.web_url}`,
  );
  return [
    `Run /mr-qa on exactly these ${mrs.length} merge request(s), oldest first:`,
    '',
    ...rows,
    '',
    `Write your JSON result to: ${resultFile}`,
  ].join('\n');
}

function runAgent({
  checkout,
  repoDirectory,
  taskPrompt,
  resultFile,
  logFile,
  model,
  timeoutMs = TIMEBOX_MS,
}) {
  const env = {
    ...process.env,
    FUTO_MR_FACTORY_RESULT_FILE: resultFile,
    // The checkout is reset every sweep, so friction is filed where the
    // maintainer's own sessions file theirs and commits it from.
    FUTO_MR_FACTORY_PAPERCUTS_FILE: path.join(repoDirectory, '.papercuts.jsonl'),
  };
  // The launcher owns every Zulip message; the agent cannot send one.
  delete env.ZULIP_FACTORY_BOT_EMAIL;
  delete env.ZULIP_FACTORY_BOT_KEY;

  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(
    'claude',
    [
      '-p',
      taskPrompt,
      '--append-system-prompt-file',
      SYSTEM_PROMPT_FILE,
      '--model',
      model,
      '--dangerously-skip-permissions',
      '--output-format',
      'text',
    ],
    { cwd: checkout, env, stdio: ['ignore', logFd, logFd] },
  );
  return new Promise((resolve) => {
    let settled = false;
    let hardKill;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardKill);
      fs.closeSync(logFd);
      resolve({
        exitCode,
        raw: fs.existsSync(resultFile) ? fs.readFileSync(resultFile, 'utf8') : null,
      });
    };
    const timer = setTimeout(() => {
      process.stderr.write('mr-factory: timebox expired, terminating agent\n');
      child.kill('SIGTERM');
      hardKill = setTimeout(() => child.kill('SIGKILL'), 30_000);
    }, timeoutMs);
    child.once('error', () => finish(null));
    child.once('exit', (code) => finish(code));
  });
}

/**
 * Comment, label, and DM for one MR that needs a human, recording each step so
 * a crash part-way never comments twice and never loses the DM: the next sweep
 * finishes any DM still marked unsent.
 */
async function reportNeedsHuman({ mr, verdict, comment, state, dir }) {
  const note = await postNote(mr.iid, formatComment(comment, mr.sha));
  state.mrs[mr.iid] = {
    sha: mr.sha,
    verdict,
    at: new Date().toISOString(),
    noteId: note.id,
    author: mr.author.username,
    webUrl: mr.web_url,
    dmSent: false,
  };
  saveState(state, dir);
  await updateLabels(mr.iid, { add: [NEEDS_HUMAN_LABEL] });
  await sendPendingDm(mr.iid, state, dir);
}

async function sendPendingDm(iid, state, dir) {
  const record = state.mrs[iid];
  await sendDm(
    AUTHORS[record.author],
    formatCommentDm({ iid: Number(iid), webUrl: record.webUrl, noteId: record.noteId }),
  );
  record.dmSent = true;
  saveState(state, dir);
}

/**
 * Turn the agent's result into GitLab and Zulip actions. Returns the problems
 * that make this sweep a failure; an MR with no trusted verdict is left
 * unrecorded so the next sweep picks it up again.
 */
async function applyResult({ selected, result, state, dir }) {
  const problems = [...result.problems.map((p) => `agent reported: ${p}`)];
  for (const iid of result.missing) problems.push(`!${iid}: no valid verdict in the result file`);

  for (const mr of selected) {
    const entry = result.verdicts.get(mr.iid);
    if (!entry) continue;
    const current = await getMr(mr.iid);
    if (entry.verdict === 'merged') {
      if (current.state !== 'merged') {
        problems.push(`!${mr.iid}: agent said merged, GitLab says ${current.state}`);
        continue;
      }
      state.mrs[mr.iid] = { sha: current.sha, verdict: 'merged', at: new Date().toISOString() };
      saveState(state, dir);
      continue;
    }
    if (current.state !== 'opened') {
      problems.push(`!${mr.iid}: agent said ${entry.verdict}, but GitLab says ${current.state}`);
      continue;
    }
    // Judge the head as it is now: a fixer push during the run is part of
    // what was judged, and the next push by a human re-opens the MR.
    await reportNeedsHuman({
      mr: current,
      verdict: entry.verdict,
      comment: entry.comment,
      state,
      dir,
    });
  }
  return problems;
}

/** Record why the sweep failed, for alertFailure.mjs to quote in the DM. */
function recordFailure(message, dir) {
  saveHealth({ ...loadHealth(dir), lastError: message.slice(0, 3000) }, dir);
}

/** Close an open outage with an all-clear DM. Only a successful sweep can see recovery. */
async function endOutage(dir) {
  const health = loadHealth(dir);
  if (!health.failing) return;
  await sendDm(OPERATOR_ZULIP_ID, formatRecoveryDm({ sinceIso: health.firstFailureAt }));
  saveHealth({ failing: false, alertCount: 0 }, dir);
}

export async function runSweep({
  dryRun = false,
  dir = stateDir(),
  repoDirectory = DEFAULT_REPO_DIR,
} = {}) {
  const state = loadState(dir);

  if (!dryRun) {
    for (const [iid, record] of Object.entries(state.mrs)) {
      if (record.dmSent === false) await sendPendingDm(iid, state, dir);
    }
  }

  const openMrs = await listOpenMrs();
  const approvers = new Map();
  for (const mr of openMrs.filter(needsApproval)) approvers.set(mr.iid, await getApprovers(mr.iid));
  const selected = selectMrs(openMrs, state, approvers);
  if (selected.length === 0) {
    process.stdout.write('mr-factory: no MR needs a verdict\n');
    if (!dryRun) await endOutage(dir);
    return { status: 'idle' };
  }

  const runId = new Date()
    .toISOString()
    .replace(/[-:T.]/g, '')
    .slice(0, 14);
  const resultFile = path.join(dir, `result-${runId}.json`);
  const logFile = path.join(dir, 'logs', `run-${runId}.log`);
  const model = process.env.FUTO_MR_FACTORY_MODEL || 'opus';
  const taskPrompt = buildTaskPrompt({ mrs: selected, resultFile });

  if (dryRun) {
    process.stdout.write(
      `[dry-run] would run /mr-qa on ${selected.length} MR(s) with model ${model}\n` +
        `system prompt: ${SYSTEM_PROMPT_FILE}\n\n--- task prompt ---\n${taskPrompt}\n`,
    );
    return { status: 'dry-run', selected: selected.map((mr) => mr.iid) };
  }

  for (const mr of selected) {
    if ((mr.labels ?? []).includes(NEEDS_HUMAN_LABEL)) {
      await updateLabels(mr.iid, { remove: [NEEDS_HUMAN_LABEL] });
    }
  }

  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const checkout = prepareCheckout({ dir, repoDirectory });
  process.stdout.write(
    `mr-factory: /mr-qa on ${selected.map((mr) => `!${mr.iid}`).join(' ')} — log ${logFile}\n`,
  );
  const { exitCode, raw } = await runAgent({
    checkout,
    repoDirectory,
    taskPrompt,
    resultFile,
    logFile,
    model,
  });

  const result =
    raw === null
      ? null
      : parseResult(
          raw,
          selected.map((mr) => mr.iid),
        );
  if (!result) {
    throw new Error(
      `agent produced no valid result (exit ${exitCode ?? 'killed'}) for ${selected.map((mr) => `!${mr.iid}`).join(' ')} — log: ${logFile}`,
    );
  }

  const problems = await applyResult({ selected, result, state, dir });
  process.stdout.write(`mr-factory: ${result.summary}\n`);
  if (problems.length > 0) throw new Error(`${problems.join('\n')}\nlog: ${logFile}`);

  await endOutage(dir);
  return { status: 'ok' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  const dir = stateDir();
  const release = dryRun ? () => {} : acquireLock(dir);
  if (!release) {
    process.stdout.write('mr-factory: another sweep is running — skipping\n');
    process.exit(0);
  }
  runSweep({ dryRun, dir })
    .then(() => {
      release();
    })
    .catch((error) => {
      release();
      const message =
        error instanceof AggregateError
          ? [error.message, ...error.errors.map((e) => e.message)].join('\n')
          : error.message;
      process.stderr.write(`mr-factory failed: ${message}\n`);
      if (!dryRun) {
        try {
          recordFailure(message, dir);
        } catch {
          /* keep the original failure as the reported one */
        }
      }
      process.exit(1);
    });
}
