import { EditorView } from '@codemirror/view';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { saveImageFile, getImageWebPath } from '$lib/fileSystem';
import { registerLocalImageUrl } from '$lib/liveMarkdownTransform';

interface MarkdownSyntax {
  prefix: string;
  suffix: string;
}

const BOLD: MarkdownSyntax = { prefix: '**', suffix: '**' };
const ITALIC: MarkdownSyntax = { prefix: '*', suffix: '*' };
const STRIKETHROUGH: MarkdownSyntax = { prefix: '~~', suffix: '~~' };

function splitSelectionWhitespace(text: string): { leading: number; trailing: number } {
  const leading = text.match(/^\s*/)?.[0].length ?? 0;
  const trailing = text.match(/\s*$/)?.[0].length ?? 0;
  return { leading, trailing };
}

function findOpeningMarkerOnLine(
  view: EditorView,
  cursorPos: number,
  prefix: string
): number | null {
  const line = view.state.doc.lineAt(cursorPos);
  const lineTextBeforeCursor = view.state.sliceDoc(line.from, cursorPos);
  const idx = lineTextBeforeCursor.lastIndexOf(prefix);
  if (idx === -1) return null;
  return line.from + idx;
}

function toggleSyntax(view: EditorView, { prefix, suffix }: MarkdownSyntax): void {
  const { state } = view;
  const { from, to } = state.selection.main;

  if (from === to) {
    // No selection - check if we're inside markers for this syntax
    const afterText = state.sliceDoc(from, from + suffix.length);

    if (afterText === suffix) {
      const beforeText = state.sliceDoc(Math.max(0, from - prefix.length), from);

      if (beforeText === prefix) {
        // Empty markers (e.g. **|**) — remove them
        view.dispatch({
          changes: { from: from - prefix.length, to: from + suffix.length, insert: '' },
          selection: { anchor: from - prefix.length }
        });
      } else {
        // Has content (e.g. **word |**) — if there is trailing whitespace before
        // closing markers, move it after the markers so markdown stays valid.
        const openPos = findOpeningMarkerOnLine(view, from, prefix);
        if (openPos !== null) {
          const contentStart = openPos + prefix.length;
          const innerText = state.sliceDoc(contentStart, from);
          const trailingWs = innerText.match(/\s+$/)?.[0] ?? '';
          if (trailingWs.length > 0) {
            const trimmedInner = innerText.slice(0, innerText.length - trailingWs.length);
            const replacement = `${prefix}${trimmedInner}${suffix}${trailingWs}`;
            view.dispatch({
              changes: {
                from: openPos,
                to: from + suffix.length,
                insert: replacement
              },
              selection: {
                anchor: openPos + prefix.length + trimmedInner.length + suffix.length + trailingWs.length
              }
            });
            view.focus();
            return;
          }
        }

        // No trailing whitespace to normalize, just jump past closing markers.
        view.dispatch({ selection: { anchor: from + suffix.length } });
      }
      view.focus();
      return;
    }

    // Not inside markers — insert new pair with cursor in middle
    view.dispatch({
      changes: { from, insert: prefix + suffix },
      selection: { anchor: from + prefix.length }
    });
    view.focus();
    return;
  }

  const selectedText = state.sliceDoc(from, to);
  const { leading, trailing } = splitSelectionWhitespace(selectedText);
  const coreFrom = from + leading;
  const coreTo = to - trailing;

  // Selection is whitespace only; wrap as-is.
  if (coreFrom >= coreTo) {
    view.dispatch({
      changes: [
        { from, insert: prefix },
        { from: to, insert: suffix }
      ],
      selection: { anchor: from + prefix.length, head: to + prefix.length }
    });
    view.focus();
    return;
  }

  // Has selection - check if markers surround non-whitespace core
  const prefixStart = Math.max(0, coreFrom - prefix.length);
  const suffixEnd = Math.min(state.doc.length, coreTo + suffix.length);
  const before = state.sliceDoc(prefixStart, coreFrom);
  const after = state.sliceDoc(coreTo, suffixEnd);

  if (before === prefix && after === suffix) {
    // Already wrapped - remove surrounding markers
    view.dispatch({
      changes: [
        { from: prefixStart, to: coreFrom, insert: '' },
        { from: coreTo, to: suffixEnd, insert: '' }
      ],
      selection: { anchor: coreFrom - prefix.length, head: coreTo - prefix.length }
    });
  } else {
    // Wrap non-whitespace core with markers; keep outer whitespace outside markers.
    view.dispatch({
      changes: [
        { from: coreFrom, insert: prefix },
        { from: coreTo, insert: suffix }
      ],
      selection: { anchor: coreFrom + prefix.length, head: coreTo + prefix.length }
    });
  }

  view.focus();
}

export function toggleBold(view: EditorView): void {
  toggleSyntax(view, BOLD);
}

export function toggleItalic(view: EditorView): void {
  toggleSyntax(view, ITALIC);
}

export function toggleStrikethrough(view: EditorView): void {
  toggleSyntax(view, STRIKETHROUGH);
}

export async function insertImage(view: EditorView, source: CameraSource): Promise<void> {
  const photo = await Camera.getPhoto({
    resultType: CameraResultType.Uri,
    source,
    quality: 90
  });

  if (!photo.path) return;

  const filename = await saveImageFile(photo.path);

  // Pre-register the web URL so the image renders immediately
  const webUrl = await getImageWebPath(filename);
  registerLocalImageUrl(filename, webUrl);

  const pos = view.state.selection.main.head;
  const insert = `![](${filename})\n`;
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length }
  });
  view.focus();
}
