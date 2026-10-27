// The held-out set: goals written the way people write them, on a ~500-note vault. Read
// README.md before touching anything here. Each task has:
//   prompt     — the goal, as a person would type it
//   families   — the verb families it needs; `names` — whether it names its notes directly
//   verify     — the vault on disk plus `state`; returns what is wrong, or null
//   reference  — the [verb, args] steps a correct driver takes (check.mjs proves them)
// Every verifier checks the WHOLE vault: exactly the notes the goal is about may change, appear
// or disappear, so a wrong-note edit or a no-op fails.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vaultDir } from './generate.mjs';
import { navigationTasks } from './tasks/navigation-tasks.mjs';
import { noteEditTasks } from './tasks/note-edit-tasks.mjs';
import { vaultChangeTasks } from './tasks/vault-change-tasks.mjs';
import { originalIds } from './tasks/vault-checks.mjs';

export const fixture = vaultDir;

// The goals in their frozen order (README.md, "The rule"): runs and check.mjs take them in it.
const byId = new Map(
  [...navigationTasks, ...noteEditTasks, ...vaultChangeTasks].map((task) => [task.id, task]),
);
export const tasks = [
  'japan-tabs',
  'grocery-tick',
  'broken-checkbox',
  'rename-groceries-2025',
  'offsite-to-archive',
  'garden-folder',
  'phone-price',
  'journal-latest',
  'journal-typo',
  'lisbon-address',
  'router-find',
  'landlord-search',
  'atlas-bold',
  'reading-heading',
  'delete-empty-untitled',
  'rename-articles-folder',
  'beacon-retro',
  'delete-tax-2024',
  'mom-birthday',
  'pancake-vanilla',
  'atlas-tabs',
  'lisbon-tag',
  'saturday-done',
  'standup-blockers',
  'weekend-errands',
  'strike-gave-up',
  'japan-past-trips',
  'grocery-budget',
].map((id) => byId.get(id));

// The checks, for the `editor` set (editor-tasks.mjs), which shares this vault.
export {
  all,
  changes,
  edited,
  lines,
  linesAdded,
  only,
  original,
  resolves,
  same,
} from './tasks/vault-checks.mjs';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const task of tasks)
    console.log(`${task.id.padEnd(24)} ${task.names.padEnd(10)} ${task.families.join(', ')}`);
  console.log(
    `${tasks.length} tasks · ${originalIds.length} notes · vault ${dirname(join(vaultDir, 'x'))}`,
  );
}
