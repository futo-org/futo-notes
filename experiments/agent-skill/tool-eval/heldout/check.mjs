// Proves every held-out task is well-formed against the running desktop app: on the untouched
// vault its verifier FAILS, and after its reference steps (driven as the harness, no Jev) it
// PASSES. Restores the workflows fixture at the end.
//   node heldout/check.mjs [--set editor] [--only id,id]
import { agent, oracle, reset } from '../reset.mjs';
// `--set editor` checks editor-tasks.mjs, on the same vault.
const { fixture, tasks } = await import(
  process.argv.includes('--set') && process.argv[process.argv.indexOf('--set') + 1] === 'editor'
    ? './editor-tasks.mjs'
    : './tasks.mjs'
);

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1].split(',')
  : null;
const receipts = (out) => {
  try {
    return JSON.parse(out);
  } catch {
    return [];
  }
};
// A batch's receipt: its first refusal, or its last step. One step is a batch too: a shortcut
// argument runs the steps it stands for after it.
const batch = (steps) => {
  const all = receipts(
    agent('do', JSON.stringify(steps.map(([verb, args = {}]) => [verb, { ...args, json: true }]))),
  );
  return all.find((receipt) => receipt.status >= 400) ?? all.at(-1);
};
const step = (verb, args) => batch([[verb, args]]);
let bad = 0;
for (const task of tasks.filter((task) => !only || only.includes(task.id))) {
  reset(fixture);
  const untouched = task.verify(oracle());
  let refused = null;
  for (const [verb, args] of task.reference) {
    let receipt = step(verb, args);
    // A row inside closed folders is reached the way a person reaches it: the refusal names the
    // batch that opens its folders, scrolls to it and runs the step. It is single-quoted shell,
    // or double-quoted with `"`, `\`, `$` and backticks escaped when the JSON holds an apostrophe.
    const call =
      receipt?.status === 409 && /\ndo (?:'(.*)'|"(.*)")$/s.exec(receipt.result?.error ?? '');
    const reach = call && (call[1] ?? call[2].replace(/\\(["\\$`])/g, '$1'));
    if (reach) receipt = batch(JSON.parse(reach));
    if (!receipt) {
      refused = `${verb}: no receipt`;
      break;
    }
    if (receipt.status >= 400) {
      refused = `${verb} ${receipt.status}: ${JSON.stringify(receipt.result).slice(0, 300)}`;
      break;
    }
  }
  const solved = refused ? `reference refused at ${refused}` : task.verify(oracle());
  const ok = untouched && !solved;
  if (!ok) bad++;
  console.log(
    `${ok ? '✓' : '✗'} ${task.id.padEnd(24)} untouched: ${untouched ? 'fails' : 'PASSES (bad)'} · reference: ${solved ? `FAILS: ${solved}` : 'passes'}`,
  );
  if (!untouched || solved) console.log(`    untouched verdict: ${untouched}`);
}
reset();
console.log(`${bad ? `${bad} bad` : 'all good'} · workflows fixture restored`);
process.exit(bad ? 1 : 0);
