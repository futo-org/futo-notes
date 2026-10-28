// The held-out vault as generated, and the checks every verifier in ../tasks.mjs builds on.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate, vaultDir } from '../generate.mjs';

const originalIds = generate();
const originals = new Map(
  originalIds.map((id) => [id, readFileSync(join(vaultDir, `${id}.md`), 'utf8')]),
);
const original = (id) => originals.get(id);
const norm = (text) => (text ?? '').replace(/\s+$/, '');
// The editor re-spells a note on its first real edit (ADR-0002, normalize-once): blank lines
// between blocks come and go. A note is compared on its non-blank lines.
// A table row is compared on its cells, a separator row as `---` cells: the editor pads both.
const tableRow = (line) =>
  /^\s*\|/.test(line)
    ? line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((cell) => (/^\s*:?-+:?\s*$/.test(cell) ? '---' : cell.trim()))
        .join(' | ')
    : line;
const lines = (text) =>
  norm(text)
    .split('\n')
    .filter((line) => line.trim())
    .map(tableRow);
const sameLines = (a, b) => JSON.stringify(lines(a)) === JSON.stringify(lines(b));

// ── checks ──
const all = (...checks) => checks.find(Boolean) ?? null;
const same = (actual, expected, what) =>
  sameLines(actual, expected)
    ? null
    : `${what}: expected ${JSON.stringify(norm(expected))}, got ${JSON.stringify(norm(actual))}`;
// The vault's changes against the generated original: which ids appeared, went, or differ.
function changes({ list, read }) {
  const now = list()
    .map((path) => path.replace(/\.md$/, ''))
    .filter((id) => !id.split('/').some((part) => part.startsWith('.')));
  const nowSet = new Set(now);
  return {
    added: now.filter((id) => !originals.has(id)).sort(),
    removed: originalIds.filter((id) => !nowSet.has(id)),
    modified: now.filter((id) => originals.has(id) && !sameLines(read(id), original(id))).sort(),
  };
}
// Exactly these changes and no others. `added: null` accepts any additions (checked by the task).
function only(oracle, { added = [], removed = [], modified = [] }) {
  const got = changes(oracle);
  const wrong = [];
  for (const [kind, want] of Object.entries({ added, removed, modified })) {
    if (want === null) continue;
    if (JSON.stringify(got[kind]) !== JSON.stringify([...want].sort()))
      wrong.push(`${kind} ${JSON.stringify(got[kind])}, want ${JSON.stringify([...want].sort())}`);
  }
  return wrong.length ? `vault changes: ${wrong.join('; ')}` : null;
}
const edited = (oracle, id, from, to) => {
  if (!original(id).includes(from))
    throw new Error(`task bug: ${id} has no ${JSON.stringify(from)}`);
  return all(
    only(oracle, { modified: [id] }),
    same(oracle.read(id), original(id).replace(from, to), id),
  );
};
const moved = (oracle, pairs) =>
  all(
    only(oracle, { added: pairs.map(([, to]) => to), removed: pairs.map(([from]) => from) }),
    ...pairs.map(([from, to]) => same(oracle.read(to), original(from), to)),
  );
// The note kept every original line in order, and the lines it gained all match `pattern`.
function linesAdded(text, id, pattern, count = 1) {
  const kept = [];
  const extra = [];
  const want = lines(original(id));
  for (const line of lines(text))
    (kept.length < want.length && line === want[kept.length] ? kept : extra).push(line);
  const gained = extra;
  if (kept.length !== want.length)
    return `${id}: original lines changed (kept ${kept.length}/${want.length}): ${JSON.stringify(norm(text))}`;
  if (gained.length !== count || !gained.every((line) => pattern.test(line)))
    return `${id}: gained ${JSON.stringify(gained)}, want ${count} line(s) matching ${pattern}`;
  return null;
}
// The open tabs are exactly these notes, in any order (neither goal asks for one); a blank tab is no note.
const tabsAre = (state, ids) => {
  const tabs = (state.tabs ?? []).filter(Boolean).sort();
  return JSON.stringify(tabs) === JSON.stringify([...ids].sort())
    ? null
    : `tabs are ${JSON.stringify(state.tabs)}, want ${JSON.stringify(ids)}`;
};
const active = (state, id) =>
  state.note?.id === id
    ? null
    : `active note is ${JSON.stringify(state.note?.id ?? null)}, want ${JSON.stringify(id)}`;
// A wikilink target resolves when exactly one note id is it or ends with `/it`.
const resolves = (ids, target) => ids.filter((id) => id === target || id.endsWith(`/${target}`));

const J = 'travel/japan 2025';
const L = 'travel/lisbon';
const P = 'work/projects';
const ARTICLES = originalIds.filter((id) => id.startsWith('reading/articles/'));
const JAPAN = originalIds.filter((id) => id.startsWith(`${J}/`));
const TAX_2024 = originalIds.filter((id) => id.startsWith('personal/finance/tax 2024/'));

export {
  active,
  all,
  ARTICLES,
  changes,
  edited,
  J,
  JAPAN,
  L,
  lines,
  linesAdded,
  moved,
  norm,
  only,
  original,
  originalIds,
  P,
  resolves,
  same,
  tabsAre,
  TAX_2024,
};
