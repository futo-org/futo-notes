// What the puppetInspector tests share: the inspector installed for each test, as the app
// installs it (which registers the editor's verbs and ScrollBy), and the page, the shell and the
// verbs cleared after it; a `do` of one verb, and the error a refusal carries.
import { afterEach, beforeEach } from 'vitest';

import { installPuppetInspector, runPuppetCommand } from './puppetInspector';
import { clearPuppetVerbs, puppetProviders } from './puppetRegistry';

beforeEach(installPuppetInspector);
afterEach(() => {
  puppetProviders.shell = null;
  clearPuppetVerbs();
  document.body.innerHTML = '';
});

export const run = (verb: string, args?: Record<string, unknown>) =>
  runPuppetCommand('do', { verb, ...(args ? { args } : {}) });
export const errorOf = (outcome: { body: unknown }) => (outcome.body as { error: string }).error;
