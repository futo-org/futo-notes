import { getFS } from '$lib/platform';
import { localizedText } from '$shared/localization';

import { ImageTooLargeError, normalizeFeedbackImage } from './normalizeImage';
import { submitFeedback } from './submitFeedback';

const DRAFT_KEY = 'futo_feedback_draft';

function loadDraftMessage(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveDraftMessage(message: string): void {
  try {
    if (message.trim()) window.localStorage.setItem(DRAFT_KEY, message);
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    return;
  }
}

export const MAX_ATTACHMENTS = 3;
const MAX_MESSAGE_LENGTH = 10_000;

interface Attachment {
  bytes: ArrayBuffer;
  previewUrl: string;
}

export function createFeedbackForm(onsent: () => void) {
  let message = $state(loadDraftMessage());
  let attachments = $state<Attachment[]>([]);
  let sending = $state(false);
  let error = $state('');

  const canSend = $derived(message.trim().length > 0 && !sending);

  function setMessage(value: string): void {
    message = value.slice(0, MAX_MESSAGE_LENGTH);
    saveDraftMessage(message);
  }

  function revokeAll(): void {
    for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
  }

  async function attachImages(): Promise<void> {
    const fs = getFS();
    const remaining = MAX_ATTACHMENTS - attachments.length;
    if (remaining <= 0 || !fs.pickImages) return;
    error = '';
    try {
      const picked = await fs.pickImages({
        limit: remaining,
        filterName: localizedText('editor.images.filePickerFilter'),
      });
      const added: Attachment[] = [];
      for (const image of picked) {
        const bytes = await normalizeFeedbackImage(image);
        added.push({ bytes, previewUrl: URL.createObjectURL(new Blob([bytes])) });
      }
      attachments = [...attachments, ...added];
    } catch (cause) {
      error =
        cause instanceof ImageTooLargeError
          ? localizedText('feedback.screenshotsTooLarge')
          : localizedText('feedback.attachFailed', {
              reason: (cause as Error)?.message ?? String(cause),
            });
    }
  }

  function removeAttachment(index: number): void {
    const removed = attachments[index];
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    attachments = attachments.filter((_, position) => position !== index);
  }

  async function send(): Promise<void> {
    if (!canSend) return;
    sending = true;
    error = '';
    try {
      await submitFeedback({
        message: message.trim(),
        images: attachments.map((attachment) => attachment.bytes),
      });
      revokeAll();
      attachments = [];
      message = '';
      saveDraftMessage('');
      onsent();
    } catch (cause) {
      error = localizedText('feedback.sendFailed', {
        reason: (cause as Error)?.message ?? String(cause),
      });
    } finally {
      sending = false;
    }
  }

  return {
    get message() {
      return message;
    },
    get attachments() {
      return attachments;
    },
    get sending() {
      return sending;
    },
    get error() {
      return error;
    },
    get canSend() {
      return canSend;
    },
    get canAttach() {
      return attachments.length < MAX_ATTACHMENTS;
    },
    setMessage,
    attachImages,
    removeAttachment,
    send,
    dispose: revokeAll,
  };
}
