import { EditorView } from '@codemirror/view';
import { getFS } from '$lib/platform';
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

// --- Line-prefix toggles ---

/** Regex patterns for line prefixes we manage */
const BULLET_RE = /^- /;
const ORDERED_RE = /^\d+\. /;
const TASK_RE = /^- \[([ x])\] /;
const HEADING_RE = /^(#{1,3}) /;
const QUOTE_RE = /^> /;

/** Returns true if the given line text (after stripping leading whitespace) is a list item. */
export function isListLine(text: string): boolean {
  const trimmed = text.trimStart();
  return BULLET_RE.test(trimmed) || ORDERED_RE.test(trimmed) || TASK_RE.test(trimmed);
}

/**
 * Toggle a line prefix. If the line already has the prefix, remove it.
 * If it has a *different* managed prefix, replace it.
 * Works on every line touched by the current selection.
 */
function toggleLinePrefix(
  view: EditorView,
  prefix: string,
  isMatch: (lineText: string) => RegExpMatchArray | null,
  allPrefixPatterns: RegExp[] = []
): void {
  const { state } = view;
  const { from, to } = state.selection.main;

  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to);

  const changes: { from: number; to: number; insert: string }[] = [];
  let selDelta = 0; // cumulative offset for cursor

  for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
    const line = state.doc.line(lineNum);
    const text = line.text;
    const match = isMatch(text);

    if (match) {
      // Already has this prefix — remove it
      changes.push({ from: line.from, to: line.from + match[0].length, insert: '' });
      if (lineNum === startLine.number) selDelta = -match[0].length;
    } else {
      // Check if line has a different managed prefix to replace
      let replaced = false;
      for (const pat of allPrefixPatterns) {
        const otherMatch = text.match(pat);
        if (otherMatch) {
          changes.push({ from: line.from, to: line.from + otherMatch[0].length, insert: prefix });
          if (lineNum === startLine.number) selDelta = prefix.length - otherMatch[0].length;
          replaced = true;
          break;
        }
      }
      if (!replaced) {
        changes.push({ from: line.from, to: line.from, insert: prefix });
        if (lineNum === startLine.number) selDelta = prefix.length;
      }
    }
  }

  const newAnchor = Math.max(0, from + selDelta);
  view.dispatch({ changes, selection: { anchor: newAnchor } });
  view.focus();
}

const ALL_LINE_PREFIXES = [BULLET_RE, ORDERED_RE, TASK_RE, HEADING_RE, QUOTE_RE];

export function toggleBulletList(view: EditorView): void {
  toggleLinePrefix(view, '- ', (t) => t.match(BULLET_RE), ALL_LINE_PREFIXES);
}

export function toggleOrderedList(view: EditorView): void {
  toggleLinePrefix(view, '1. ', (t) => t.match(ORDERED_RE), ALL_LINE_PREFIXES);
}

export function toggleTaskList(view: EditorView): void {
  toggleLinePrefix(view, '- [ ] ', (t) => t.match(TASK_RE), ALL_LINE_PREFIXES);
}

export function cycleHeading(view: EditorView): void {
  const { state } = view;
  const { from } = state.selection.main;
  const line = state.doc.lineAt(from);
  const text = line.text;
  const headingMatch = text.match(HEADING_RE);

  if (headingMatch) {
    const level = headingMatch[1].length;
    if (level < 3) {
      // Upgrade: # -> ## -> ###
      const newPrefix = '#'.repeat(level + 1) + ' ';
      const oldLen = headingMatch[0].length;
      view.dispatch({
        changes: { from: line.from, to: line.from + oldLen, insert: newPrefix },
        selection: { anchor: from + (newPrefix.length - oldLen) }
      });
    } else {
      // At ###, remove heading
      view.dispatch({
        changes: { from: line.from, to: line.from + headingMatch[0].length, insert: '' },
        selection: { anchor: from - headingMatch[0].length }
      });
    }
  } else {
    // No heading — check for other prefixes first
    for (const pat of ALL_LINE_PREFIXES) {
      const m = text.match(pat);
      if (m) {
        view.dispatch({
          changes: { from: line.from, to: line.from + m[0].length, insert: '# ' },
          selection: { anchor: from + (2 - m[0].length) }
        });
        view.focus();
        return;
      }
    }
    // Clean line, add H1
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: '# ' },
      selection: { anchor: from + 2 }
    });
  }
  view.focus();
}

export function toggleBlockquote(view: EditorView): void {
  toggleLinePrefix(view, '> ', (t) => t.match(QUOTE_RE), ALL_LINE_PREFIXES);
}

/**
 * Pick an image using a hidden <input type="file">.
 * On iOS, `capture="environment"` opens the camera; omitting it shows the photo library.
 */
function pickImageFromInput(source: 'camera' | 'photos'): Promise<File | null> {
  return new Promise((resolve) => {
    let resolved = false;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    if (source === 'camera') {
      input.capture = 'environment';
    }
    input.style.display = 'none';
    document.body.appendChild(input);

    const cleanup = () => {
      window.removeEventListener('focus', onFocus);
      if (input.parentElement) document.body.removeChild(input);
    };

    const done = (file: File | null) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(file);
    };

    input.addEventListener('change', () => done(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => done(null));

    // Fallback: browsers/platforms without cancel event — focus returns to window
    const onFocus = () => {
      setTimeout(() => done(null), 300);
    };
    window.addEventListener('focus', onFocus);

    input.click();
  });
}

/** Insert an image from camera or photo library (mobile). Uses native iOS pickers. */
export async function insertImageFromCamera(
  view: EditorView,
  source: 'camera' | 'photos',
): Promise<void> {
  const fs = getFS();

  // If saveImageBytes is available (Tauri/mobile), use HTML input for native iOS pickers
  if (fs.saveImageBytes) {
    const file = await pickImageFromInput(source);
    if (!file) return;

    const buffer = await file.arrayBuffer();
    const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg';
    const filename = await fs.saveImageBytes(buffer, ext);
    const webUrl = await fs.getImageUrl(filename);
    registerLocalImageUrl(filename, webUrl);
    insertImageMarkdown(view, filename);
    return;
  }

  // Fallback: desktop file picker
  await insertImageFromFile(view);
}

/** Insert an image from a file picker (desktop). */
export async function insertImageFromFile(view: EditorView): Promise<void> {
  const sourcePath = await getFS().pickImage?.();
  if (!sourcePath) return;

  const fs = getFS();
  const filename = await fs.saveImage(sourcePath);
  const webUrl = await fs.getImageUrl(filename);
  registerLocalImageUrl(filename, webUrl);

  insertImageMarkdown(view, filename);
}

function insertImageMarkdown(view: EditorView, filename: string): void {
  const pos = view.state.selection.main.head;
  const insert = `![](${filename})\n`;
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
  });
  view.focus();
}
