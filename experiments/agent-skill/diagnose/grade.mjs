// Grading a finished run: its tool calls, the ones that reached the running app, the verdict.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { cleanEnv, outDir } from './config.mjs';

/** The tool calls with their results, trimmed: what the grader reads to decide "recreated". */
function digest(runDir) {
  const events = readFileSync(join(runDir, 'transcript.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const results = new Map();
  for (const event of events.filter((e) => e.type === 'user'))
    for (const block of Array.isArray(event.message.content) ? event.message.content : [])
      if (block.type === 'tool_result')
        results.set(
          block.tool_use_id,
          (Array.isArray(block.content)
            ? block.content.map((c) => c.text ?? '').join('')
            : String(block.content ?? '')
          ).slice(0, 6000),
        );
  const calls = events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => e.message.content.filter((b) => b.type === 'tool_use'))
    .map((b) => ({
      tool: b.name,
      input:
        b.input.command ??
        b.input.file_path ??
        b.input.pattern ??
        JSON.stringify(b.input).slice(0, 300),
      content: b.input.content ?? b.input.new_string ?? '',
      result: results.get(b.id) ?? '',
    }));
  const final = events.find((e) => e.type === 'result');
  return {
    calls,
    answer: final?.result ?? '',
    costUsd: final?.total_cost_usd ?? null,
    turns: final?.num_turns ?? null,
  };
}

// A call reaches the RUNNING app only through a channel the live app answers, the same rule on every
// arm: this branch's `just puppet` CLI, a window capture (`just qa-shot`) or the instance resolver
// (`qa-target.mjs`); or main's documented route, code run against the debug bridge's WebSocket
// (execute_js, capture_native_screenshot, invoke_tauri). Reading code or the vault on disk, unit
// tests, and browsers (Playwright, agent-browser) are not the running app.
const APP_CLI = /\b(just puppet|futo-puppet|just qa-shot|qa-shot\.mjs|qa-target(\.mjs)?)\b/;
const BRIDGE =
  /\b(execute_js|capture_native_screenshot|invoke_tauri)\b|wss?:\/\/(127\.0\.0\.1|localhost|\[::1\])/;
// A bridge client only reaches the app when something runs it; `cat > x.mjs <<EOF … EOF` alone only writes it.
const RUNS_CODE = /\b(node|python3?|bun|deno|tsx|websocat)\b/;
const SCRIPT_PATH = /[\w./~-]+\.(?:mjs|cjs|js|ts|py|sh)\b/g;

/**
 * Bash calls that reached the running app: a CLI call; a command that runs bridge code inline
 * (`node <<EOF`, or writes a client and runs it in the same command); or a command that runs a
 * script an earlier call wrote with bridge code in it, wherever it lives (attached as `script`).
 */
function appCallsOf(calls) {
  const scripts = new Map(); // file name → the text that wrote it
  for (const c of calls) {
    const text = c.tool === 'Bash' ? c.input : ['Write', 'Edit'].includes(c.tool) ? c.content : '';
    if (!BRIDGE.test(text)) continue;
    const paths =
      c.tool === 'Bash' ? [...c.input.matchAll(SCRIPT_PATH)].map((m) => m[0]) : [c.input];
    for (const path of paths) scripts.set(basename(path), text);
  }
  return calls.flatMap((c) => {
    if (c.tool !== 'Bash') return [];
    if (APP_CLI.test(c.input)) return [c];
    if (!RUNS_CODE.test(c.input)) return [];
    if (BRIDGE.test(c.input)) return [c];
    const script = [...scripts.keys()].find((name) => c.input.includes(name));
    return script ? [{ ...c, script: scripts.get(script) }] : [];
  });
}

/** Images the agent opened that live outside the run (e.g. a bridge capture in /tmp): copied before the next run can overwrite them. */
function keepReadImages(runDir) {
  let calls = [];
  try {
    calls = digest(runDir).calls;
  } catch {
    return; // a cut-off transcript: grade() reports it
  }
  for (const c of calls)
    if (
      c.tool === 'Read' &&
      /\.(png|jpe?g)$/i.test(c.input) &&
      !c.input.includes('/.puppet/') &&
      existsSync(c.input)
    ) {
      mkdirSync(join(runDir, 'reads'), { recursive: true });
      cpSync(c.input, join(runDir, 'reads', basename(c.input)));
    }
}

function grade(bug, runDir) {
  const { calls, answer, costUsd, turns } = digest(runDir);
  const agentCalls = appCallsOf(calls);
  const driveCalls = agentCalls.filter((c) => /\bdrive\b/.test(c.input));
  const sourceReads = calls.filter(
    (c) =>
      ['Read', 'Grep', 'Glob'].includes(c.tool) ||
      (c.tool === 'Bash' && /^\s*(rg|grep|cat|sed|head|find)\b/.test(c.input)),
  );
  const edits = calls.filter((c) => ['Edit', 'Write', 'MultiEdit'].includes(c.tool));
  const appCalls = agentCalls
    .map(
      (c, i) =>
        `#${i + 1} $ ${c.input}${c.script ? `\n(the script it runs:)\n${c.script.slice(0, 3000)}` : ''}\n${c.result}`,
    )
    .join('\n\n')
    .slice(0, 60_000);
  // Screenshots of the running app the agent opened: `just puppet screenshot` writes them under
  // .puppet/screens/ (moved into the run directory when the run ended); any other image counts only
  // when an app call (its command, script or output) names it, e.g. a bridge capture or `just
  // qa-shot`, so a Playwright or browser screenshot is not passed off as the app. Copies: reads/.
  const appText = agentCalls.map((c) => `${c.input}\n${c.script ?? ''}\n${c.result}`).join('\n');
  const screenshots = calls
    .filter(
      (c) =>
        c.tool === 'Read' &&
        /\.(png|jpe?g)$/i.test(c.input) &&
        (c.input.includes('/.puppet/screens/') || appText.includes(basename(c.input))),
    )
    .map((c) =>
      join(
        runDir,
        c.input.includes('/.puppet/screens/') ? 'agent/screens' : 'reads',
        basename(c.input),
      ),
    )
    .filter((path, i, all) => existsSync(path) && all.indexOf(path) === i);
  const graderPrompt = `You grade whether a coding agent diagnosed a bug in a notes app. Reply with ONLY a JSON object.

Bug report the agent got: ${JSON.stringify(bug.prompt)}

The real root cause (answer key): ${bug.key}

What the bug looks like in the app when recreated: ${bug.sign}

The agent's commands that reached the RUNNING app (the \`just puppet\` CLI, a script over the app's debug-bridge WebSocket, a window capture, or the instance resolver), each with its output:
${appCalls || '(none — it never touched the running app)'}
${screenshots.length ? `\nScreenshots of the running app the agent took and looked at — open each with Read; what they show counts as app output:\n${screenshots.join('\n')}\n` : ''}
The agent's final answer:
${answer.slice(0, 8000)}

Return {"recreated": true|false, "recreatedEvidence": "<which command output shows the bug happening, quoting it briefly, or why not>", "cause": "correct"|"partial"|"wrong", "causeReason": "<one sentence>"}.
"recreated" is true only if the app-command OUTPUT or a screenshot above shows THIS bug happening — the behaviour described under "What the bug looks like" — not a different oddity the agent found, and not if it merely reasoned about it or read code. "cause" is "correct" when the answer names the same mechanism as the key (file/function level or unambiguous equivalent), "partial" when it is in the right area but misses or muddles the mechanism, "wrong" otherwise.`;
  const graded = spawnSync(
    'claude',
    [
      '-p',
      graderPrompt,
      '--model',
      'claude-sonnet-5-5',
      '--output-format',
      'json',
      '--tools',
      screenshots.length ? 'Read' : '',
      ...(screenshots.length ? ['--allowedTools', 'Read'] : []),
      '--setting-sources',
      'project',
      '--max-turns',
      String(1 + screenshots.length * 2),
    ],
    // cwd outside every checkout: the grader must not load either arm's AGENTS.md.
    { cwd: outDir, env: cleanEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 },
  );
  let verdict = { error: graded.stderr?.slice(0, 500) };
  let graderCostUsd = null;
  try {
    const reply = JSON.parse(graded.stdout);
    graderCostUsd = reply.total_cost_usd ?? null;
    const text = reply.result;
    verdict = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    /* keep the error */
  }
  const score = {
    ...verdict,
    appCalls: agentCalls.length,
    driveCalls: driveCalls.length,
    driveOutcomes: driveCalls.map((c) => /outcome: (\S+)/.exec(c.result)?.[1] ?? '?'),
    firstAppCall: agentCalls[0]?.input.slice(0, 160) ?? null,
    gateRefusals: agentCalls.filter((c) => c.result.includes('acting on the app goes through Jev'))
      .length,
    jevOffCalls: agentCalls.filter((c) => /FUTO_PUPPET_JEV=off/.test(c.input)).length,
    driveFirst: Boolean(agentCalls[0] && /\bdrive\b/.test(agentCalls[0].input)),
    sourceReads: sourceReads.length,
    edits: edits.length,
    toolCalls: calls.length,
    turns,
    costUsd,
    graderCostUsd,
  };
  writeFileSync(join(runDir, 'score.json'), `${JSON.stringify(score, null, 2)}\n`);
  writeFileSync(join(runDir, 'answer.md'), `${answer}\n`);
  return score;
}

export { grade, keepReadImages };
