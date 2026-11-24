// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  hasFileSystem: true,
  onFileDrop: () => () => {},
}));

import { runPuppetCommand } from './puppetInspector';
import './puppetInspector.fixture';
import { registerPuppetShell } from './puppetRegistry';

describe('elements', () => {
  function button(label: string, handler?: () => void): HTMLButtonElement {
    const element = document.createElement('button');
    element.textContent = label;
    if (handler) {
      // How Svelte 5 stores a delegated handler on its element.
      (element as unknown as Record<symbol, unknown>)[Symbol('events')] = { click: handler };
    }
    // jsdom lays nothing out; give the element a rect so it counts as visible.
    element.getBoundingClientRect = () => new DOMRect(10, 20, 100, 30);
    document.body.appendChild(element);
    return element;
  }

  it('lists interactables with stable refs, roles, handlers and rects', () => {
    function selectTab() {}
    button('Notes', selectTab);
    const svelteRoot = document.createElement('div');
    (svelteRoot as unknown as { __svelte_meta: unknown }).__svelte_meta = {
      loc: { file: 'src/features/tabs/TabsStrip.svelte', line: 1, column: 1 },
    };
    document.body.appendChild(svelteRoot);
    const plus = button('+');
    svelteRoot.appendChild(plus);

    const first = runPuppetCommand('elements', {}).body as {
      elements: Array<Record<string, unknown>>;
    };
    expect(first.elements).toMatchObject([
      {
        ref: 'e1',
        component: null,
        role: 'button',
        text: 'Notes',
        handlers: ['click=selectTab'],
        flags: [],
        rect: { x: 10, y: 20, w: 100, h: 30 },
      },
      {
        ref: 'e2',
        component: 'TabsStrip.svelte',
        role: 'button',
        text: '+',
        handlers: [],
        flags: [],
        rect: { x: 10, y: 20, w: 100, h: 30 },
      },
    ]);
    const again = runPuppetCommand('elements', {}).body as { elements: Array<{ ref: string }> };
    expect(again.elements.map((row) => row.ref)).toEqual(['e1', 'e2']);
  });

  it('hides zero-size elements unless asked for all, and scopes to a ref', () => {
    const hidden = document.createElement('button');
    hidden.textContent = 'ghost';
    document.body.appendChild(hidden);
    const holder = document.createElement('section');
    holder.getBoundingClientRect = () => new DOMRect(0, 0, 500, 500);
    document.body.appendChild(holder);
    holder.appendChild(button('inside'));
    holder.setAttribute('role', 'tab');

    const visible = runPuppetCommand('elements', {}).body as { elements: Array<{ text: string }> };
    expect(visible.elements.map((row) => row.text)).toEqual(['inside', 'inside']);
    const all = runPuppetCommand('elements', { all: true }).body as {
      elements: Array<{ text: string; flags: string[] }>;
    };
    expect(all.elements.find((row) => row.text === 'ghost')?.flags).toContain('hidden');
    const holderRef = (
      runPuppetCommand('elements', {}).body as { elements: Array<{ ref: string; role: string }> }
    ).elements.find((row) => row.role === 'tab')!.ref;
    const scoped = runPuppetCommand('elements', { in: holderRef }).body as {
      elements: Array<{ text: string }>;
    };
    expect(scoped.elements.map((row) => row.text)).toEqual(['inside', 'inside']);
  });

  it('observe carries the vault, so a driver sees notes a collapsed folder hides', () => {
    const vault = { notes: ['welcome', 'work/standup'], folders: ['work'] };
    registerPuppetShell({ screen: () => 'home', state: () => ({ tabs: [] }), vault: () => vault });
    const observation = runPuppetCommand('observe', {}).body as {
      notes: string[];
      folders: string[];
      tabs: unknown[];
    };
    expect(observation.notes).toEqual(vault.notes);
    expect(observation.folders).toEqual(vault.folders);
    expect(observation.tabs).toEqual([]);
  });

  it('show describes one ref and 404s a ref that is gone', () => {
    const element = button('Bold');
    const ref = (runPuppetCommand('elements', {}).body as { elements: Array<{ ref: string }> })
      .elements[0]!.ref;
    const shown = runPuppetCommand('show', { ref }).body as Record<string, unknown>;
    expect(shown).toMatchObject({
      ref,
      tag: 'button',
      text: 'Bold',
      hitVersusPaint: { matches: true, misses: [] },
    });
    element.remove();
    expect(runPuppetCommand('show', { ref }).status).toBe(404);
  });
});
