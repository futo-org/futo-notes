#!/usr/bin/env node
// PreToolUse(Bash) hook: refuse a `just puppet` action whose receipt is filtered away, and a
// filtered `look`, which is the whole screen in one read.
//
// A receipt is what an action did to the app — the vault line saying a new note was discarded,
// the refusal saying why — and it is the input to the agent's next step. In the first full
// held-out run agents piped 92% of them into `head`, `grep status` or `/dev/null`, and the one
// miss was a `GoBack | grep status` that hid exactly that vault line (docs/research/
// agent-native-app-design.md, "Read whole"). A receipt is a few lines of text, so
// the action is refused and runs again unfiltered. Reads (`notes | grep budget`) are lookups and
// pass. Wired in .claude/settings.json; exit 2 blocks and shows stderr to the agent. A shell
// check in front starts node only for a command that mentions puppet, as every action does,
// so the other Bash calls skip node's ~19 ms start. ponytail: a puppet command still pays it;
// a `futo-puppet hook` subcommand in Rust would not, once the hook can count on the binary
// being built (a fresh worktree has none, and a missing hook lets the command through).
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// In a subshell `(…)` too, and through `cargo run -p futo-puppet -- do …`.
const ACTION =
  /(^|[\s(])(just\s+puppet|(\S*\/)?futo-puppet)\s+(--\s+)?(do|tap|click|drag|scroll|type|press|relaunch|look)(\s|$)/;

/**
 * The commands of a shell line, each with its pipes and stdout redirects found outside quotes:
 * `a | b; c > f` is [{text: 'a | b', piped: true}, {text: 'c > f', redirected: true}].
 * `ponytail:` quoting is '…' and "…" with backslash escapes, enough for the JSON arguments
 * agents write; `$(…)` and here-docs are not looked inside.
 */
function commands(line) {
  const found = [];
  let text = '';
  let piped = false;
  let redirected = false;
  let quote = null;
  const end = () => {
    if (text.trim()) found.push({ text: text.trim(), piped, redirected });
    text = '';
    piped = false;
    redirected = false;
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];
    if (quote) {
      text += char;
      if (char === '\\' && quote === '"') text += line[++index] ?? '';
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      text += char;
    } else if (
      char === ';' ||
      char === '\n' ||
      (char === '&' && next === '&') ||
      (char === '|' && next === '|')
    ) {
      if (char !== ';' && char !== '\n') index++;
      end();
    } else if (char === '|') {
      piped = true;
      text += char;
    } else if (char === '>') {
      // `2>` and `2>&1` move stderr, which the agent still sees; any other `>` takes stdout.
      const stderr = line[index - 1] === '2' && /^\s?$/.test(line[index - 2] ?? '');
      if (!stderr) redirected = true;
      text += char;
    } else {
      text += char;
    }
  }
  end();
  return found;
}

/** The action in `line` whose receipt is piped or redirected away, or null. */
export function filteredAction(line) {
  return (
    commands(line).find(
      (command) => ACTION.test(command.text) && (command.piped || command.redirected),
    ) ?? null
  );
}

const LOOK = /(^|[\s(])(just\s+puppet|(\S*\/)?futo-puppet)\s+(--\s+)?look(\s|$)/;

const refusal = (command) =>
  LOOK.test(command.text)
    ? `Blocked, so nothing in this command ran: \`${command.text}\` filters \`look\`, the whole ` +
      `screen in one read: run it with nothing after it and read it whole, or search one of the ` +
      `reads it combines, like \`just puppet elements | grep standup\`.`
    : actionRefusal(command);

const actionRefusal = (command) =>
  `Blocked, so nothing in this command ran: \`${command.text}\` filters the action's receipt. ` +
  `A receipt is what the action did to the app and the input to your next step, under 60 ` +
  `lines: run the whole command again with nothing (\`|\`, \`head\`, \`tail\`, \`grep\`, ` +
  `\`>/dev/null\`) after the action, and read the receipt whole (puppet skill, "Run each ` +
  `action bare"). Searching a read, like \`just puppet notes | grep budget\`, is fine.`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  const command = filteredAction(input.tool_input?.command ?? '');
  if (command) {
    process.stderr.write(`${refusal(command)}\n`);
    process.exit(2);
  }
}
