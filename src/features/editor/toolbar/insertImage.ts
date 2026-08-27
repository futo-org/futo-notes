import type { EditorView } from '@codemirror/view';

import { getFS } from '$lib/platform';

import { registerLocalImageUrl } from '../liveMarkdownTransform';

export async function insertImageFromFile(view: EditorView): Promise<void> {
  const fs = getFS();
  if (!fs.saveImageBytes) return;

  const [picked] = (await fs.pickImages?.({ limit: 1 })) ?? [];
  if (!picked) return;

  const filename = await fs.saveImageBytes(picked.bytes, picked.extension);
  registerLocalImageUrl(filename, await fs.getImageUrl(filename));

  const position = view.state.selection.main.head;
  const markdown = `![](${filename})\n`;
  view.dispatch({
    changes: { from: position, insert: markdown },
    selection: { anchor: position + markdown.length },
  });
  view.focus();
}
