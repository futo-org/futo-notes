/* The agent's clipboard, which every editor's Copy, Cut and Paste use: never the OS one,
 * which belongs to the person at this machine. */
import { type ClipboardAccess, type PuppetClipboardContent } from './puppetInput';
import { ok, type Args, type PuppetOutcome } from './puppetRegistry';

const CLIPBOARD_TEXT_LIMIT = 80;

/** What `Copy` or `Cut` last took; survives switching notes, since the page does. */
let puppetClipboard: PuppetClipboardContent | null = null;

export const clipboardAccess: ClipboardAccess = {
  content: () => puppetClipboard,
  copied: (content) => {
    if (content) puppetClipboard = content;
  },
};

/** What `state.editor.clipboard` shows: the text, cut as the selection's is. `clipboard`
 *  reads it whole. */
export function clipboardText(): string | null {
  if (!puppetClipboard) return null;
  const { text } = puppetClipboard;
  return text.length > CLIPBOARD_TEXT_LIMIT ? `${text.slice(0, CLIPBOARD_TEXT_LIMIT)}…` : text;
}

/**
 * The puppet clipboard: `{"clear":true}` empties it (a harness resets it between tasks), and
 * `{"text":"…","html"?:"…","image"?:"<PNG in base64>"}` fills it as copying from another app
 * would, for Paste to test what the editor makes of outside text or a picture.
 */
export function clipboard(args: Args): PuppetOutcome {
  if (args.clear === true) puppetClipboard = null;
  const image = typeof args.image === 'string' ? args.image : undefined;
  if (typeof args.text === 'string' || image) {
    puppetClipboard = {
      text: typeof args.text === 'string' ? args.text : '',
      html: typeof args.html === 'string' ? args.html : '',
      ...(image ? { image } : {}),
    };
  }
  return ok({ clipboard: puppetClipboard });
}
