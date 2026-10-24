import { expect, it } from 'vitest';
import { parsePapercutLog } from './papercut-log.mjs';

it('keeps the first duplicate cut and applies resolves regardless of event order', () => {
  const first = { kind: 'cut', id: 'pc_a', text: 'first' };
  const log =
    [
      { kind: 'resolve', id: 'pc_b' },
      first,
      { ...first, text: 'duplicate' },
      { kind: 'cut', id: 'pc_b' },
      { kind: 'resolve', id: 'pc_b' },
      { kind: 'future-event', id: 'pc_c' },
      null,
    ]
      .map(JSON.stringify)
      .join('\n') + '\nmalformed\n';
  expect(parsePapercutLog(log)).toEqual({ open: [first], total: 2 });
  expect(parsePapercutLog('')).toEqual({ open: [], total: 0 });
});
