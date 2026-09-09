// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PickedImage } from '$lib/platform/types';

const submitFeedback = vi.fn();
const pickImages = vi.fn();
vi.mock('$lib/platform', () => ({ getFS: () => ({ pickImages }) }));
vi.mock('./submitFeedback', () => ({
  submitFeedback: (...args: unknown[]) => submitFeedback(...args),
}));

const { createFeedbackForm, MAX_ATTACHMENTS } = await import('./createFeedbackForm.svelte');

const savedDraft = () => window.localStorage.getItem('futo_feedback_draft') ?? '';

function pngOfSize(bytes: number): PickedImage {
  const data = new Uint8Array(bytes);
  data.set([0x89, 0x50, 0x4e, 0x47]);
  return { bytes: data.buffer, extension: 'png' };
}

describe('createFeedbackForm', () => {
  beforeEach(() => {
    window.localStorage.clear();
    submitFeedback.mockReset();
    pickImages.mockReset();
    submitFeedback.mockResolvedValue(undefined);
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:preview');
    globalThis.URL.revokeObjectURL = vi.fn();
  });

  it('cannot send until a message is given', () => {
    const form = createFeedbackForm(() => {});
    expect(form.canSend).toBe(false);

    form.setMessage('the toolbar hides my cursor');
    expect(form.canSend).toBe(true);
  });

  it('cannot send a whitespace-only message', () => {
    const form = createFeedbackForm(() => {});
    form.setMessage('   \n  ');
    expect(form.canSend).toBe(false);
  });

  it('sends the trimmed message', async () => {
    const onsent = vi.fn();
    const form = createFeedbackForm(onsent);
    form.setMessage('  please add tables  ');
    await form.send();

    expect(submitFeedback).toHaveBeenCalledWith({
      message: 'please add tables',
      images: [],
    });
    expect(onsent).toHaveBeenCalled();
  });

  it('sends nothing the user did not type — no route, no session, no vault path', async () => {
    const form = createFeedbackForm(() => {});
    form.setMessage('crash on open');
    await form.send();

    const draft = submitFeedback.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(draft).sort()).toEqual(['images', 'message']);
  });

  it('clears the form and the saved draft once it lands', async () => {
    const form = createFeedbackForm(() => {});
    form.setMessage('gone after sending');
    await form.send();

    expect(form.message).toBe('');
    expect(savedDraft()).toBe('');
  });

  it('keeps the message so the user can retry when the send fails', async () => {
    submitFeedback.mockRejectedValue(new Error('could not reach the server'));
    const onsent = vi.fn();
    const form = createFeedbackForm(onsent);
    form.setMessage('still here');
    await form.send();

    expect(form.message).toBe('still here');
    expect(form.error).toContain('could not reach the server');
    expect(onsent).not.toHaveBeenCalled();
    expect(savedDraft()).toBe('still here');
  });

  it('restores the message typed before a restart', () => {
    const first = createFeedbackForm(() => {});
    first.setMessage('typed before closing');

    expect(createFeedbackForm(() => {}).message).toBe('typed before closing');
  });

  it('asks the picker only for the slots that are still free', async () => {
    pickImages.mockResolvedValue([pngOfSize(64)]);
    const form = createFeedbackForm(() => {});

    await form.attachImages();
    expect(pickImages).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: MAX_ATTACHMENTS }),
    );

    await form.attachImages();
    expect(pickImages).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: MAX_ATTACHMENTS - 1 }),
    );
  });

  it('stops offering attachments at the cap', async () => {
    pickImages.mockResolvedValue([pngOfSize(64), pngOfSize(64), pngOfSize(64)]);
    const form = createFeedbackForm(() => {});
    await form.attachImages();

    expect(form.attachments).toHaveLength(MAX_ATTACHMENTS);
    expect(form.canAttach).toBe(false);

    await form.attachImages();
    expect(pickImages).toHaveBeenCalledTimes(1);
  });

  it('releases the preview url of a removed attachment', async () => {
    pickImages.mockResolvedValue([pngOfSize(64)]);
    const form = createFeedbackForm(() => {});
    await form.attachImages();
    form.removeAttachment(0);

    expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    expect(form.attachments).toHaveLength(0);
  });

  it('reports a picker failure without losing the message', async () => {
    pickImages.mockRejectedValue(new Error('picker exploded'));
    const form = createFeedbackForm(() => {});
    form.setMessage('kept');
    await form.attachImages();

    expect(form.error).toContain('picker exploded');
    expect(form.message).toBe('kept');
  });

  it('caps the message at the length the server accepts', () => {
    const form = createFeedbackForm(() => {});
    form.setMessage('a'.repeat(10_050));
    expect(form.message).toHaveLength(10_000);
  });
});
