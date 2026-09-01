import { describe, expect, it, vi } from 'vitest';

import type { LocalNoteMutation } from '$lib/localNoteStore';
import { createExternalFileOpenCoordinator } from './externalFileOpen';

const mutation: LocalNoteMutation = {
  upserted: [],
  removed: [],
  renamed: [],
  folders: [],
  finalId: 'grocery list-2',
  finalFolder: null,
  warnings: [],
};

function makeDependencies() {
  return {
    whenReady: vi.fn().mockResolvedValue(undefined),
    confirmCopy: vi.fn().mockResolvedValue(true),
    copy: vi.fn().mockResolvedValue(mutation),
    applyMutation: vi.fn(),
    notifySaved: vi.fn(),
    openNote: vi.fn(),
    showError: vi.fn(),
  };
}

describe('external Markdown open coordinator', () => {
  it('opens a vault note directly without prompting or copying', async () => {
    const dependencies = makeDependencies();
    const coordinator = createExternalFileOpenCoordinator(dependencies);

    coordinator.handle({ kind: 'insideVault', id: 'Plans/launch notes' });
    await coordinator.whenIdle();

    expect(dependencies.openNote).toHaveBeenCalledWith('Plans/launch notes');
    expect(dependencies.confirmCopy).not.toHaveBeenCalled();
    expect(dependencies.copy).not.toHaveBeenCalled();
  });

  it('leaves an external source untouched when the user cancels', async () => {
    const dependencies = makeDependencies();
    dependencies.confirmCopy.mockResolvedValue(false);
    const coordinator = createExternalFileOpenCoordinator(dependencies);

    coordinator.handle({ kind: 'outsideVault', path: '/tmp/list.md', name: 'list.md' });
    await coordinator.whenIdle();

    expect(dependencies.copy).not.toHaveBeenCalled();
    expect(dependencies.openNote).not.toHaveBeenCalled();
  });

  it('projects and opens the collision-resolved id after a confirmed copy', async () => {
    const dependencies = makeDependencies();
    const coordinator = createExternalFileOpenCoordinator(dependencies);

    coordinator.handle({
      kind: 'outsideVault',
      path: '/tmp/grocery list.markdown',
      name: 'grocery list.markdown',
    });
    await coordinator.whenIdle();

    expect(dependencies.copy).toHaveBeenCalledWith('/tmp/grocery list.markdown');
    expect(dependencies.applyMutation).toHaveBeenCalledWith(mutation);
    expect(dependencies.notifySaved).toHaveBeenCalledOnce();
    expect(dependencies.openNote).toHaveBeenCalledWith('grocery list-2');
  });

  it('serializes multiple OS requests so confirmations cannot overlap', async () => {
    const dependencies = makeDependencies();
    let releaseFirst!: (confirmed: boolean) => void;
    dependencies.confirmCopy.mockImplementationOnce(
      () => new Promise<boolean>((resolve) => (releaseFirst = resolve)),
    );
    const coordinator = createExternalFileOpenCoordinator(dependencies);

    coordinator.handle({ kind: 'outsideVault', path: '/tmp/one.md', name: 'one.md' });
    coordinator.handle({ kind: 'insideVault', id: 'two' });
    await Promise.resolve();
    await Promise.resolve();

    expect(dependencies.openNote).not.toHaveBeenCalled();
    releaseFirst(false);
    await coordinator.whenIdle();
    expect(dependencies.openNote).toHaveBeenCalledWith('two');
  });
});
