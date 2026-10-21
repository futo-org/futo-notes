// @vitest-environment jsdom
/*
 * Canaries for the two places keyboardParity.ts answers a binding the presets
 * own, read from the REAL presets as the app builds them (the keymaps live in
 * each `$useKeymap`'s ctx slice, so this reads the slices rather than mirroring
 * the shortcut strings):
 *
 * - `keepDeleteForward` takes Delete off the preset's start-of-block Backspace
 *   commands. A red "upstream still binds Delete" case means upstream changed
 *   the binding under the pinned `@milkdown/kit`: delete the override, do not
 *   relax the canary.
 * - `SHIFTED_CHORD_GUARDS` must cover every shifted letter chord whose
 *   unshifted twin is also bound. A new pair is a chord that can run its twin
 *   (prosemirror-keymap's Shift fallback): add a guard for it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Editor, defaultValueCtx, rootCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { history } from '@milkdown/kit/plugin/history';
import * as historyExports from '@milkdown/kit/plugin/history';
import * as commonmarkExports from '@milkdown/kit/preset/commonmark';
import { headingKeymap, listItemKeymap } from '@milkdown/kit/preset/commonmark';
import * as gfmExports from '@milkdown/kit/preset/gfm';

import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { SHIFTED_CHORD_GUARDS, keepDeleteForward } from './keyboardParity';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';

type KeymapSlice = typeof listItemKeymap.key;
type KeymapConfig = Record<string, { shortcuts: string | string[] }>;

const editors: Editor[] = [];
const roots: HTMLElement[] = [];

async function build(configure: (ctx: Ctx) => void = () => {}): Promise<Editor> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  roots.push(root);
  const editor = await withoutLeakedCtxTimers(() =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, '');
        configure(ctx);
      })
      .use(commonmarkWithCompat())
      .use(gfmWithCompat())
      .use(history)
      .create(),
  );
  editors.push(editor);
  return editor;
}

let upstream: Editor;
let configured: Editor;

beforeAll(async () => {
  upstream = await build();
  configured = await build(keepDeleteForward);
});

afterAll(async () => {
  for (const editor of editors) await editor.destroy();
  for (const root of roots) root.remove();
});

const shortcutsOf = (editor: Editor, slice: KeymapSlice, name: string): string[] =>
  [(editor.ctx.get(slice) as KeymapConfig)[name].shortcuts].flat();

describe('Delete stays a forward delete (keepDeleteForward)', () => {
  it('canary: upstream still binds Delete to the start-of-block Backspace commands', () => {
    expect(shortcutsOf(upstream, listItemKeymap.key, 'LiftFirstListItem')).toContain('Delete');
    expect(shortcutsOf(upstream, headingKeymap.key, 'DowngradeHeading')).toContain('Delete');
  });

  it('keeps those commands on Backspace only', () => {
    expect(shortcutsOf(configured, listItemKeymap.key, 'LiftFirstListItem')).toEqual(['Backspace']);
    expect(shortcutsOf(configured, headingKeymap.key, 'DowngradeHeading')).toEqual(['Backspace']);
  });
});

/** A chord as its modifier set plus key, so `Shift-Mod-z` and `Mod-Shift-z` compare equal. */
function chord(spec: string): string {
  const parts = spec.split('-');
  const key = parts.pop() ?? '';
  return [...parts.sort(), key].join('-');
}

/** Every shortcut of every keymap slice the presets and the history plugin export. */
function allShortcuts(editor: Editor): string[] {
  const slices = [commonmarkExports, gfmExports, historyExports].flatMap((module) =>
    Object.entries(module)
      .filter(([name, value]) => name.endsWith('Keymap') && value && 'key' in value)
      .map(([, value]) => (value as { key: KeymapSlice }).key),
  );
  expect(slices.length).toBeGreaterThan(10);
  return slices.flatMap((slice) =>
    Object.values(editor.ctx.get(slice) as KeymapConfig).flatMap((entry) =>
      [entry.shortcuts].flat(),
    ),
  );
}

describe('a shifted chord never runs its unshifted twin (SHIFTED_CHORD_GUARDS)', () => {
  it('guards exactly the shifted letter chords whose unshifted twin is bound', () => {
    const bound = new Set(allShortcuts(upstream).map(chord));
    const twins = [...bound].filter((spec) => {
      const parts = spec.split('-');
      const key = parts[parts.length - 1];
      if (!parts.includes('Shift') || !/^[a-z]$/.test(key)) return false;
      return bound.has(chord(spec.replace(/(^|-)Shift(?=-)/, '').replace(/^-/, '')));
    });
    expect(twins.sort()).toEqual(Object.keys(SHIFTED_CHORD_GUARDS).map(chord).sort());
  });
});
