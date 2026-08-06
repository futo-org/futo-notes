import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { parseDirListing, quoteForDeviceShell, splitBatchOutput } from './adbClient.mjs';

const DELIMITER = '__futo_adb_batch__';
/** What the device shell streams back for `cmd; echo DELIM` per command. */
const framed = (...outputs) => outputs.map((out) => `${out}${DELIMITER}\n`).join('');

describe('splitBatchOutput', () => {
  it('returns each command output in order', () => {
    expect(splitBatchOutput(framed('Welcome.md\n', 'DEVICE\n'), 2)).toEqual([
      'Welcome.md\n',
      'DEVICE\n',
    ]);
  });

  /**
   * The regression this function exists for: a note's trailing newline is
   * content, and trimming it made every byte-for-byte vault comparison fail with
   * "migrated note content differs".
   */
  it('keeps a trailing newline, which is file content and not framing', () => {
    expect(splitBatchOutput(framed('# Groceries\n- milk\n'), 1)).toEqual(['# Groceries\n- milk\n']);
  });

  it('handles output with no trailing newline, where the marker glues on', () => {
    expect(splitBatchOutput(framed('no-newline'), 1)).toEqual(['no-newline']);
  });

  it('reports an empty result for a command that printed nothing', () => {
    expect(splitBatchOutput(framed('', 'APP\n'), 2)).toEqual(['', 'APP\n']);
  });

  /** A command killed mid-batch leaves later outputs absent, not undefined. */
  it('pads missing entries so a caller never destructures undefined', () => {
    expect(splitBatchOutput(framed('only'), 3)).toEqual(['only', '', '']);
  });

  it('returns nothing when the batch produced no output at all', () => {
    expect(splitBatchOutput('', 2)).toEqual(['', '']);
  });
});

describe('quoteForDeviceShell', () => {
  /**
   * Checked against a real POSIX shell rather than an expected-string, because the
   * property that matters is that the shell on the far side parses the value back
   * to exactly one argument equal to the input. Hand-written expectations here
   * test the author's model of the quoting grammar, not the grammar.
   */
  const throughAShell = (value) =>
    execFileSync('sh', ['-c', `printf %s ${quoteForDeviceShell(value)}`], { encoding: 'utf8' });

  it('survives a path with spaces as one argument', () => {
    const path = '/sdcard/Documents/FUTO Notes Dev/Groceries.md';
    expect(throughAShell(path)).toBe(path);
    expect(
      execFileSync('sh', ['-c', `set -- ${quoteForDeviceShell(path)}; echo $#`], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('1');
  });

  /** A note can legitimately be called "Dad's list". */
  it('survives an apostrophe, which would otherwise end the quoted run', () => {
    expect(throughAShell("Dad's list.md")).toBe("Dad's list.md");
  });

  it('contains a value that tries to break out and run a command', () => {
    const hostile = "x'; rm -rf /sdcard; echo '";
    expect(throughAShell(hostile)).toBe(hostile);
  });

  it('survives the rest of the shell metacharacters', () => {
    for (const value of ['a b', '$HOME', '`id`', 'a;b', 'a|b', 'a&b', 'a\\b', 'a"b', '*']) {
      expect(throughAShell(value)).toBe(value);
    }
  });
});

describe('parseDirListing', () => {
  it('lists entries without the self-links', () => {
    expect(parseDirListing('.\n..\nWelcome.md\nGroceries.md\n')).toEqual([
      'Welcome.md',
      'Groceries.md',
    ]);
  });

  it('keeps names containing spaces intact', () => {
    expect(parseDirListing('.\n..\nSeeded Note.md\n')).toEqual(['Seeded Note.md']);
  });

  it('returns nothing for a missing directory', () => {
    expect(parseDirListing('')).toEqual([]);
  });
});
