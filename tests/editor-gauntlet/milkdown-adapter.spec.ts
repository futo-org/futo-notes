import { expect, test } from '@playwright/test';

import { MilkdownGauntletAdapter } from './milkdownAdapter';
import type { FakeHostWindow } from '../lib/editorEmbedHost';

/**
 * Red-proofs for the Milkdown adapter's own signals.
 *
 * The foreign sweep gates on "never refuse", and a `refused` that cannot be
 * true would make that line unfalsifiable — a silent green (M11). These tests
 * are the standing proof that it fires, and that a normal edit does not trip
 * it. They also pin the two position bugs found while building the adapter,
 * both of which produced plausible-looking wrong answers rather than errors.
 */

test('a delivered edit is not a refusal, and the shell and file agree', async ({ browser }) => {
  const adapter = new MilkdownGauntletAdapter(browser);
  try {
    await adapter.open('hello world', 'delivered');
    await adapter.select({ anchor: 0, rich: { anchor: { text: 'hello', offset: 0 } } });
    await adapter.perform({ type: 'insert-text', text: 'X' });
    const saved = await adapter.save();

    expect(saved.refused).toBe(false);
    expect(saved.source).toBe('Xhello world\n');
    expect(saved.shellSource, 'the shell must hold what the editor holds').toBe(saved.source);
    expect(saved.savedSource, 'the file must hold what the editor holds').toBe(saved.source);
  } finally {
    await adapter.dispose();
  }
});

test('an edit the shell never hears about is reported as refused', async ({ browser }) => {
  const adapter = new MilkdownGauntletAdapter(browser);
  try {
    await adapter.open('hello world', 'dropped');
    // Drop `change` posts on the floor: the host stops learning about edits,
    // which is the shape the 200ms-debounced listener fails in (#105). Every
    // other message still gets through.
    await adapter.page.evaluate(() => {
      const host = window as unknown as FakeHostWindow & {
        futoBridge: { postMessage(json: string): void };
      };
      const original = host.futoBridge.postMessage.bind(host.futoBridge);
      host.futoBridge.postMessage = (json: string) => {
        if ((JSON.parse(json) as { type: string }).type === 'change') return;
        original(json);
      };
    });

    await adapter.select({ anchor: 0, rich: { anchor: { text: 'hello', offset: 0 } } });
    await adapter.perform({ type: 'insert-text', text: 'X' });
    const saved = await adapter.save();

    expect(saved.refused, 'the edit never reached the shell, so it is a refusal').toBe(true);
    expect(saved.source, 'the editor still holds the edit').toBe('Xhello world\n');
    expect(saved.savedSource, 'and the file still holds the note as it was').toBe('hello world');
  } finally {
    await adapter.dispose();
  }
});

test('a caret after a soft line break lands before the next character', async ({ browser }) => {
  const adapter = new MilkdownGauntletAdapter(browser);
  try {
    // One paragraph with a soft break. The break is a ProseMirror NODE, not
    // text; counting it as zero characters put the caret one place right, so
    // backspace ate the 'b' instead of joining the lines.
    await adapter.open('alpha\nbeta', 'soft-break');
    await adapter.select({ anchor: 0, rich: { anchor: { text: 'beta', offset: 0 } } });
    await adapter.perform({ type: 'backspace' });

    expect((await adapter.save()).source).toBe('alphabeta\n');
  } finally {
    await adapter.dispose();
  }
});

test('a caret on a paragraph boundary lands in the following paragraph', async ({ browser }) => {
  const adapter = new MilkdownGauntletAdapter(browser);
  try {
    // 'alpha' and 'beta' are adjacent in the rendered text, so offset 5 is both
    // the end of the first paragraph and the start of the second. Only the
    // latter is a ProseMirror position where backspace joins the blocks.
    await adapter.open('alpha\n\nbeta', 'paragraph-boundary');
    await adapter.select({ anchor: 0, rich: { anchor: { text: 'beta', offset: 0 } } });
    await adapter.perform({ type: 'backspace' });

    expect((await adapter.save()).source).toBe('alphabeta\n');
  } finally {
    await adapter.dispose();
  }
});
