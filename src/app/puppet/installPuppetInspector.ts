import { TEST_HOOKS_ENABLED } from '../testHooksEnabled';
import { installListenerRegistry } from './puppetListeners';
import { installTrace } from './puppetTrace';

/**
 * Load the puppet inspector in a dev or opted-in build. The gate is a
 * compile-time constant, so a shipped bundle drops the branch, tree-shakes the
 * two side-effect-free modules imported here, and never loads the inspector
 * chunk — no reachable `window.__futoPuppet`.
 *
 * The trace recorder and listener registry install synchronously, in that
 * order: the app mounts right after this call, and a listener attached before
 * the patch is one the trace can never see — while the trace's own window
 * listeners must predate the patch so they are not recorded as handlers.
 */
export function installPuppetInspector(): void {
  if (TEST_HOOKS_ENABLED) {
    installTrace();
    installListenerRegistry();
    void import('./puppetInspector').then((module) => module.installPuppetInspector());
  }
}
