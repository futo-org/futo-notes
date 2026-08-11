import { describe, expect, it } from 'vitest';

import { RULES, applyAllowlist, scanText } from './check-qa-input-safety.mjs';

// The techniques this gate bans are the ones that, on 2026-08-10, sent real
// Cmd+Z keystrokes from a QA agent into the user's production vault. These tests
// pin both directions: the patterns must fire on the real recorded shapes, and
// they must NOT fire on the ordinary prose that surrounds them (this repo's
// instruction files are full of "per-keystroke" and of legitimate path-scoped
// process lookups).

const ruleIds = (text) => scanText(text).map((hit) => hit.rule);

describe('scanText — the banned shapes', () => {
  it('flags the exact AppleScript incantation from the incident', () => {
    const line =
      `osascript -e 'tell application "System Events" to tell (first application process ` +
      `whose unix id is 4321) to keystroke "z" using {command down}'`;
    expect(ruleIds(line)).toEqual(
      expect.arrayContaining([
        'system-events-ui-scripting',
        'applescript-keystroke',
        'unix-id-process-lookup',
      ]),
    );
  });

  it('flags a name-based process lookup against the app', () => {
    expect(ruleIds('TAURI_PID=$(pgrep -f "futo-notes-tauri" | tail -1)')).toEqual([
      'app-process-name-lookup',
    ]);
  });

  it('flags the lookup when the app name wraps onto the next line', () => {
    const text = [
      'and pushes the next launch to the next port — `pkill -f',
      '"futo-notes-tauri"`.',
    ].join('\n');
    const hits = scanText(text);
    expect(hits).toHaveLength(1);
    // Reported where the command is, not where the wrapped name landed.
    expect(hits[0]).toMatchObject({ line: 1, rule: 'app-process-name-lookup' });
  });

  it('flags cliclick and relative -newermt', () => {
    expect(ruleIds('cliclick c:400,300')).toEqual(['cliclick']);
    expect(ruleIds('find ~/Documents/futo-notes -newermt "-24 hours"')).toEqual([
      'relative-newermt',
    ]);
    expect(ruleIds("find . -newermt '-1 day'")).toEqual(['relative-newermt']);
  });
});

describe('scanText — what it must leave alone', () => {
  it('does not fire on ordinary prose about keystrokes', () => {
    const prose = [
      '**M5 — Background jank.** Typing is sacred: only sanctioned hot-path TS runs per keystroke;',
      'destructive latch is DROPPED on Android after a dropped-keystroke divergence',
      'tapping placeholder title selects the whole title for next-keystroke replace',
    ].join('\n');
    expect(scanText(prose)).toEqual([]);
  });

  it('does not fire on a path-scoped process lookup that cannot hit the release app', () => {
    expect(
      scanText('`pgrep -af "worktrees/mr-<iid>" | grep -E \'cargo|gradle|tauri|vite\'`'),
    ).toEqual([]);
  });

  it('does not fire on the safe measurement forms', () => {
    expect(scanText('touch -t 202608101200 /tmp/ref && find . -newer /tmp/ref')).toEqual([]);
    expect(scanText('find . -newermt "2026-08-10 12:00:00"')).toEqual([]);
  });

  it('does not fire on the sanctioned resolver itself', () => {
    expect(scanText('node scripts/qa-target.mjs port 9231   # exit 3 = refused')).toEqual([]);
  });
});

describe('applyAllowlist', () => {
  const hit = { line: 14, rule: 'cliclick', text: '- **OS-level input** (`cliclick`) is unsafe' };

  it('permits an exactly pinned line', () => {
    const result = applyAllowlist(
      { 'docs/x.md': [hit] },
      { 'docs/x.md': [{ rule: 'cliclick', line: hit.text, reason: 'names it to forbid it' }] },
    );
    expect(result).toEqual({ violations: [], staleEntries: [] });
  });

  it('still fails a NEW occurrence inside an allowlisted file', () => {
    const fresh = { line: 90, rule: 'cliclick', text: 'cliclick c:10,10' };
    const result = applyAllowlist(
      { 'docs/x.md': [hit, fresh] },
      { 'docs/x.md': [{ rule: 'cliclick', line: hit.text, reason: 'names it to forbid it' }] },
    );
    expect(result.violations).toEqual([{ file: 'docs/x.md', ...fresh }]);
  });

  it('fails a pinned line that no longer exists (the allowlist cannot rot)', () => {
    const result = applyAllowlist(
      {},
      { 'docs/x.md': [{ rule: 'cliclick', line: 'gone', reason: 'stale' }] },
    );
    expect(result.violations).toEqual([]);
    expect(result.staleEntries).toHaveLength(1);
    expect(result.staleEntries[0].file).toBe('docs/x.md');
  });

  it('does not let one pinned line excuse two identical occurrences', () => {
    const result = applyAllowlist(
      { 'docs/x.md': [hit, { ...hit, line: 20 }] },
      { 'docs/x.md': [{ rule: 'cliclick', line: hit.text, reason: 'once' }] },
    );
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].line).toBe(20);
  });
});

describe('rule metadata', () => {
  it('gives every rule a reason and a sanctioned alternative', () => {
    for (const rule of RULES) {
      expect(rule.why.length).toBeGreaterThan(20);
      expect(rule.instead.length).toBeGreaterThan(20);
    }
  });
});
