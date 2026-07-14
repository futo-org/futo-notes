import { indentLess, indentMore } from '@codemirror/commands';
import type { EditorView } from '@codemirror/view';

import { toggleLink } from './editorUX/linkCommand';
import {
  cycleHeading,
  toggleBlockquote,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
} from './toolbar/blockFormatting';
import { toggleBold, toggleItalic, toggleStrikethrough } from './toolbar/inlineFormatting';

export {
  cycleHeading,
  isListLine,
  toggleBlockquote,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
} from './toolbar/blockFormatting';
export { insertImageFromFile } from './toolbar/insertImage';
export { toggleBold, toggleItalic, toggleStrikethrough } from './toolbar/inlineFormatting';

export const TOOLBAR_EXEC: Record<string, (view: EditorView) => void> = {
  bold: toggleBold,
  italic: toggleItalic,
  strikethrough: toggleStrikethrough,
  link: (view) => toggleLink(view, () => ''),
  heading: cycleHeading,
  quote: toggleBlockquote,
  'bullet-list': toggleBulletList,
  'ordered-list': toggleOrderedList,
  'task-list': toggleTaskList,
  outdent: (view) => {
    indentLess(view);
  },
  indent: (view) => {
    indentMore(view);
  },
};
