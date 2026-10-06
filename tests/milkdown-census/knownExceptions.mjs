/**
 * The notes a hard gate (`content_loss`, `second_pass_unstable`) flags that the
 * maintainer has accepted, and the gate verdict that holds the census to them.
 *
 * An exception is named by note — the corpus file and the note's index in it —
 * never by a pattern, so a new note of the same shape still fails the gate.
 * Every flagged note is still printed; the list only decides the verdict. An
 * entry whose note is no longer flagged is reported so the list can shrink.
 *
 * Each entry carries a synthetic repro of the shape (never the note's own
 * text) and why it is accepted. docs/editor/milkdown-roundtrip-census.md and
 * the README list the same entries for readers.
 */

/** The flags a save must not raise (#266); the rest are a scorecard. */
export const GATE_FLAGS = ['content_loss', 'second_pass_unstable'];

/**
 * A quoted list indented with tabs, under a `>` line holding only whitespace.
 * The parser reads the innermost one-item list as LOOSE in this spelling only
 * (mdast `spread`); the house style writes it with spaces, which reads tight.
 * Nothing the author wrote changes but that attribute, and by CommonMark's own
 * rule the list is tight in both spellings.
 */
const QUOTED_TAB_LIST = {
  shape: '> 1. A\n> \t- B\n> \t\t- C\n> \n>2. D',
  reason:
    "the parser marks the one-item list C loose only through the tab indentation and the whitespace-only `> ` line; the save writes it tight, which is CommonMark's own reading (maintainer decision 1, 2026-10-06)",
};

export const KNOWN_EXCEPTIONS = [
  { corpus: 'notes_corpus.jsonl.gz', id: '8761', flag: 'content_loss', ...QUOTED_TAB_LIST },
  { corpus: 'notes_corpus.jsonl.gz', id: '9151', flag: 'content_loss', ...QUOTED_TAB_LIST },
  { corpus: 'notes_corpus.jsonl.gz', id: '9478', flag: 'content_loss', ...QUOTED_TAB_LIST },
];

/**
 * The gate verdict for one run. `source` is the corpus file's basename, or
 * `'vault'` (no exception applies to a vault). Passes only when every note a
 * gate flagged is a known exception for that flag and every note was checked:
 * a note the harness could not run was never held to the gate.
 *
 * @param {{ id: string, flags: Record<string, true>, error?: string }[]} records
 * @param {string} source
 */
export function gateVerdict(records, source, exceptions = KNOWN_EXCEPTIONS) {
  const known = new Map(
    exceptions
      .filter((entry) => entry.corpus === source)
      .map((entry) => [`${entry.flag}\u0000${entry.id}`, entry]),
  );
  const flagged = [];
  const seen = new Set();
  for (const record of records) {
    seen.add(record.id);
    for (const flag of GATE_FLAGS) {
      if (!record.flags?.[flag]) continue;
      flagged.push({
        id: record.id,
        flag,
        exception: known.get(`${flag}\u0000${record.id}`) ?? null,
      });
    }
  }
  const unexpected = flagged.filter((row) => row.exception === null);
  const unchecked = records
    .filter((record) => record.error !== undefined)
    .map((record) => record.id);
  const listed = new Set(flagged.map((row) => `${row.flag}\u0000${row.id}`));
  const stale = [...known.values()].filter(
    (entry) => seen.has(entry.id) && !listed.has(`${entry.flag}\u0000${entry.id}`),
  );
  return {
    pass: unexpected.length === 0 && unchecked.length === 0,
    flagged,
    unexpected,
    unchecked,
    stale,
  };
}

/** The verdict as the lines `run.mjs` prints. */
export function describeVerdict(verdict) {
  const lines = [];
  for (const row of verdict.flagged) {
    const note = row.exception
      ? `known exception: ${row.exception.reason}`
      : 'NOT a known exception';
    lines.push(`  ${row.flag} ${row.id} — ${note}`);
  }
  for (const id of verdict.unchecked)
    lines.push(`  unchecked ${id} — the harness could not run it`);
  for (const entry of verdict.stale) {
    lines.push(`  ${entry.flag} ${entry.id} is no longer flagged: remove it from KNOWN_EXCEPTIONS`);
  }
  const known = verdict.flagged.length - verdict.unexpected.length;
  lines.push(
    verdict.pass
      ? `gate verdict: PASS — ${verdict.flagged.length} flagged, all known exceptions`
      : `gate verdict: FAIL — ${verdict.unexpected.length} flagged notes are not known exceptions` +
          ` (${known} are), ${verdict.unchecked.length} unchecked`,
  );
  return lines;
}
