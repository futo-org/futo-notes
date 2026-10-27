// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { runPuppetCommand } from './puppetInspector';
import {
  puppetProviders,
  puppetVerb,
  clearPuppetVerbs,
  registerPuppetShell,
  registerPuppetVerbs,
} from './puppetRegistry';

afterEach(() => {
  puppetProviders.shell = null;
  clearPuppetVerbs();
});

describe('the vault, which the tree draws only part of', () => {
  it('notes answers the vault, which no DOM query can, with its times when asked', () => {
    const vault = { notes: ['welcome'], folders: ['recipes'], modified: { welcome: 7 } };
    expect(runPuppetCommand('notes', {}).status).toBe(501);
    registerPuppetShell({ screen: () => 'home', state: () => ({}), vault: () => vault });
    expect(runPuppetCommand('notes', {}).body).toEqual({
      notes: ['welcome'],
      folders: ['recipes'],
    });
    expect(runPuppetCommand('notes', { modified: true }).body).toEqual(vault);
  });
});
