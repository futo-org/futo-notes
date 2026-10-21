// @vitest-environment jsdom
/*
 * Canary for keyboardParity.ts `keepDeleteForward`, read from the REAL presets
 * as the app builds them (the keymaps live in each `$useKeymap`'s ctx slice, so
 * this reads the slices rather than mirroring the shortcut strings). It takes
 * Delete off the preset's start-of-block Backspace commands. A red "upstream
 * still binds Delete" case means upstream changed the binding under the pinned
 * `@milkdown/kit`: delete the override, do not relax the canary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Editor, defaultValueCtx, rootCtx } from '@milkdown/kit/core';
import type { Ctx } from '@milkdown/kit/ctx';
import { headingKeymap, listItemKeymap } from '@milkdown/kit/preset/commonmark';

import { commonmarkWithCompat, gfmWithCompat } from '@futo-notes/editor/milkdown-compat';
import { keepDeleteForward } from './keyboardParity';
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
