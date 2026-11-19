/* A code block's code onto the clipboard, from its header's copy button (codeBlockHeader.ts),
 * and a toast saying whether it got there: a write the clipboard refuses must not read as a
 * press that never landed. */
import { recordPuppetCopy } from '$app/puppet/puppetRegistry';
import { getPlatformFS } from '$lib/platform';
import { showGlobalToast } from '$shared/notifications/toastBus.svelte';

/** True once `text` is on the clipboard. */
export async function copyCodeToClipboard(text: string): Promise<boolean> {
  try {
    await (await getPlatformFS()).writeClipboardText(text);
  } catch (error) {
    console.warn('code block copy failed:', error);
    showGlobalToast({ path: 'editor.codeBlock.copyFailed' });
    return false;
  }
  recordPuppetCopy(text);
  showGlobalToast({ path: 'editor.codeBlock.copied' });
  return true;
}
