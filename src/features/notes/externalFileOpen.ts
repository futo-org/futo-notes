import type { LocalNoteMutation } from '$lib/localNoteStore';
import {
  copyExternalNoteIntoVault,
  onExternalFileOpen,
  type ExternalFileOpenRequest,
} from '$lib/platform';
import { notifySaved } from '$features/sync/autoSync';
import { confirmDialog } from '$shared/dialogs/confirmDialog';
import { localizedText } from '$shared/localization';
import { showGlobalToast, type ToastMessage } from '$shared/notifications/toastBus.svelte';

interface ExternalFileOpenDependencies {
  whenReady: () => Promise<unknown>;
  confirmCopy: (name: string) => Promise<boolean>;
  copy: (path: string) => Promise<LocalNoteMutation>;
  applyMutation: (mutation: LocalNoteMutation) => void;
  notifySaved: () => void;
  openNote: (id: string) => void;
  showError: (message: ToastMessage) => void;
}

export function createExternalFileOpenCoordinator(deps: ExternalFileOpenDependencies): {
  handle(request: ExternalFileOpenRequest): void;
  whenIdle(): Promise<void>;
} {
  let pending = Promise.resolve();

  const handle = (request: ExternalFileOpenRequest): void => {
    pending = pending
      .then(async () => {
        await deps.whenReady();
        if (request.kind === 'insideVault') {
          deps.openNote(request.id);
          return;
        }

        if (!(await deps.confirmCopy(request.name))) return;
        const mutation = await deps.copy(request.path);
        const id = mutation.finalId;
        if (!id) throw new Error('The imported note did not have a final name');
        deps.applyMutation(mutation);
        deps.notifySaved();
        deps.openNote(id);
      })
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        deps.showError({ path: 'notes.errors.externalOpenFailed', arguments: { detail } });
      });
  };

  return { handle, whenIdle: () => pending };
}

export function startExternalFileOpen(
  dependencies: Pick<ExternalFileOpenDependencies, 'whenReady' | 'applyMutation' | 'openNote'>,
): () => void {
  const coordinator = createExternalFileOpenCoordinator({
    ...dependencies,
    confirmCopy: (name) =>
      confirmDialog(localizedText('notes.externalOpen.confirmation', { name }), {
        title: localizedText('notes.externalOpen.title'),
        confirmLabel: localizedText('notes.externalOpen.confirmLabel'),
      }),
    copy: copyExternalNoteIntoVault,
    notifySaved,
    showError: showGlobalToast,
  });
  return onExternalFileOpen(coordinator.handle);
}
