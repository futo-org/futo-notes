import { describe, expect, it } from 'vitest';

import { describeVerdict, gateVerdict } from './knownExceptions.mjs';

const CORPUS = 'notes_corpus.jsonl.gz';
const exception = {
  corpus: CORPUS,
  id: '7',
  flag: 'content_loss',
  shape: 'x',
  reason: 'accepted',
};
const note = (id, flags = {}, extra = {}) => ({ id, flags, ...extra });

describe('the census gate verdict', () => {
  it('passes when every flagged note is a known exception, and still lists each one', () => {
    const verdict = gateVerdict([note('7', { content_loss: true }), note('8')], CORPUS, [
      exception,
    ]);
    expect(verdict.pass).toBe(true);
    expect(verdict.flagged).toEqual([{ id: '7', flag: 'content_loss', exception }]);
    expect(describeVerdict(verdict).join('\n')).toContain('content_loss 7 — known exception');
  });

  it('fails on any other flagged note, or on a listed note flagged by the other gate', () => {
    const other = gateVerdict([note('8', { content_loss: true })], CORPUS, [exception]);
    expect(other.pass).toBe(false);
    const otherGate = gateVerdict([note('7', { second_pass_unstable: true })], CORPUS, [exception]);
    expect(otherGate.unexpected).toEqual([
      { id: '7', flag: 'second_pass_unstable', exception: null },
    ]);
  });

  it('applies an exception only to its own corpus', () => {
    const vault = gateVerdict([note('7', { content_loss: true })], 'vault', [exception]);
    expect(vault.pass).toBe(false);
  });

  it('fails when a note could not be checked, and ignores the scorecard flags', () => {
    const verdict = gateVerdict(
      [note('1', { unstable: true }), note('2', {}, { error: 'timeout' })],
      CORPUS,
      [],
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.unchecked).toEqual(['2']);
  });

  it('reports an exception whose note is no longer flagged, without failing', () => {
    const verdict = gateVerdict([note('7')], CORPUS, [exception]);
    expect(verdict.pass).toBe(true);
    expect(verdict.stale).toEqual([exception]);
  });
});
