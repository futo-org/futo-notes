import type { EditorView } from '@codemirror/view';

import { getFS } from '$lib/platform';

import { registerLocalImageUrl } from '../liveMarkdownTransform';

export async function insertImageFromFile(view: EditorView): Promise<void> {
  const sourcePath = await getFS().pickImage?.();
  if (!sourcePath) return;

  const fs = getFS();
  const filename = await fs.saveImage(sourcePath);
  registerLocalImageUrl(filename, await fs.getImageUrl(filename));

  const position = view.state.selection.main.head;
  const markdown = `![](${filename})\n`;
  view.dispatch({
    changes: { from: position, insert: markdown },
    selection: { anchor: position + markdown.length },
  });
  view.focus();
}
