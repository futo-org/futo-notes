// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import { clearPuppetVerbs, registeredVerbs } from '$app/puppet/puppetRegistry';
import { runPuppetCommand } from '$app/puppet/puppetInspector';
import ContextMenu, { type MenuItem } from './ContextMenu.svelte';

describe('ContextMenu dismissal', () => {
  let target: HTMLDivElement;
  let outside: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;
  const onclose = vi.fn();

  beforeEach(() => {
    target = document.createElement('div');
    outside = document.createElement('div');
    document.body.append(target, outside);
    app = mount(ContextMenu, {
      target,
      props: {
        x: 0,
        y: 0,
        items: [
          {
            label: { path: 'sidebar.contextMenu.rename' },
            onclick: vi.fn(),
            verb: { name: 'RenameFolder' },
          },
        ],
        onclose,
      },
    });
    flushSync();
  });

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target.remove();
    outside.remove();
  });

  function press(element: Element): void {
    element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    flushSync();
  }

  it('closes on a pointer press outside the menu', () => {
    press(outside);
    expect(onclose).toHaveBeenCalledTimes(1);
  });

  it('stays open on a pointer press inside the menu', () => {
    press(document.querySelector('.context-menu .menu-item')!);
    expect(onclose).not.toHaveBeenCalled();
  });
});

describe('ContextMenu options as verbs', () => {
  let target: HTMLDivElement;
  let app: ReturnType<typeof mount> | null = null;

  afterEach(() => {
    if (app) unmount(app);
    app = null;
    target.remove();
    clearPuppetVerbs();
  });

  function open(items: MenuItem[], onclose = vi.fn()) {
    target = document.createElement('div');
    document.body.append(target);
    app = mount(ContextMenu, { target, props: { x: 0, y: 0, items, onclose } });
    flushSync();
    return onclose;
  }

  it('offers each option under its own name while open, with its shortcut and label', () => {
    const rename = vi.fn();
    const onclose = open([
      {
        label: { path: 'common.actions.rename' },
        onclick: rename,
        verb: {
          name: 'RenameFolder',
          shortcut: { argument: 'name', steps: [['SetNewName', { name: '$' }], ['SubmitRename']] },
        },
      },
      {
        label: { path: 'common.actions.delete' },
        onclick: vi.fn(),
        disabled: true,
        verb: { name: 'DeleteFolder', confirms: true },
      },
    ]);
    const verbs = registeredVerbs();
    expect(verbs.map((verb) => verb.name)).toEqual([
      'RenameFolder',
      'DeleteFolder',
      'CloseContextMenu',
    ]);
    expect(verbs[0]).toMatchObject({
      controls: ['common.actions.rename'],
      shortcuts: { name: [['SetNewName', { name: '$' }], ['SubmitRename']] },
      schema: { properties: { name: { type: 'string' } }, required: [] },
    });
    expect(verbs[1]!.schema.properties.answer).toBeDefined();

    expect(runPuppetCommand('do', { verb: 'DeleteFolder', args: {} }).status).toBe(409);
    expect(runPuppetCommand('do', { verb: 'RenameFolder', args: {} }).status).toBe(200);
    expect(rename).toHaveBeenCalledOnce();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it('runs a confirming option in a click’s order: the option, then the menu closes', async () => {
    const order: string[] = [];
    open(
      [
        {
          label: { path: 'common.actions.delete' },
          onclick: () => order.push('option'),
          verb: { name: 'DeleteFolder', confirms: true },
        },
      ],
      vi.fn(() => order.push('close')),
    );
    await registeredVerbs()[0]!.run({});
    expect(order).toEqual(['option', 'close']);
  });
});
