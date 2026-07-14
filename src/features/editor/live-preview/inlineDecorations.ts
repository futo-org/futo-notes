import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';

import { ImageWidget } from './images';
import type { PendingDecoration } from './decorationTypes';
import { shouldRevealInlineMarkers } from './selectionReveal';
import { ExternalLinkWidget } from './widgets';

export function decorateEmphasis(
  nodeName: string,
  from: number,
  to: number,
  text: string,
  view: EditorView,
  decorations: PendingDecoration[],
): void {
  const isStrong = nodeName === 'StrongEmphasis';
  const cssClass = isStrong ? 'cm-md-strong' : 'cm-md-emphasis';
  const markerLength = isStrong ? 2 : 1;
  if (text.length < markerLength * 2) return;

  const revealMarkers = shouldRevealInlineMarkers(view, from, to);
  if (!revealMarkers) {
    decorations.push(
      { from, to: from + markerLength, value: { replace: true } },
      { from: to - markerLength, to, value: { replace: true } },
    );
  } else {
    const markerClass = isStrong
      ? 'cm-md-inline-marker cm-md-strong-marker'
      : 'cm-md-inline-marker cm-md-emphasis-marker';
    decorations.push(
      { from, to: from + markerLength, value: { class: markerClass } },
      { from: to - markerLength, to, value: { class: markerClass } },
      { from, to: from + markerLength, value: { class: cssClass } },
      { from: to - markerLength, to, value: { class: cssClass } },
    );
  }
  decorations.push({
    from: from + markerLength,
    to: to - markerLength,
    value: { class: cssClass },
  });
}

export function decorateStrikethrough(
  from: number,
  to: number,
  view: EditorView,
  decorations: PendingDecoration[],
): void {
  const revealMarkers = shouldRevealInlineMarkers(view, from, to);
  if (!revealMarkers) {
    decorations.push(
      { from, to: from + 2, value: { replace: true } },
      { from: to - 2, to, value: { replace: true } },
    );
  } else {
    decorations.push(
      {
        from,
        to: from + 2,
        value: { class: 'cm-md-inline-marker cm-md-strikethrough-marker' },
      },
      {
        from: to - 2,
        to,
        value: { class: 'cm-md-inline-marker cm-md-strikethrough-marker' },
      },
      { from, to: from + 2, value: { class: 'cm-md-strikethrough' } },
      { from: to - 2, to, value: { class: 'cm-md-strikethrough' } },
    );
  }
  decorations.push({ from: from + 2, to: to - 2, value: { class: 'cm-md-strikethrough' } });
}

export function decorateLink(
  from: number,
  to: number,
  text: string,
  view: EditorView,
  decorations: PendingDecoration[],
): void {
  const closeBracket = text.indexOf('](');
  if (text[0] !== '[' || closeBracket === -1) return;

  const textStart = from + 1;
  const textEnd = from + closeBracket;
  const urlStart = textEnd + 2;
  const urlEnd = to - 1;
  const reveal = shouldRevealInlineMarkers(view, from, to);

  if (!reveal) {
    decorations.push(
      { from, to: from + 1, value: { replace: true } },
      { from: textEnd, to, value: { replace: true } },
      { from: textStart, to: textEnd, value: { class: 'cm-md-link' } },
    );
  } else {
    decorations.push(
      {
        from,
        to: from + 1,
        value: { class: 'cm-md-inline-marker cm-md-link-marker cm-md-link' },
      },
      { from: textStart, to: textEnd, value: { class: 'cm-md-link' } },
      {
        from: textEnd,
        to: textEnd + 1,
        value: { class: 'cm-md-inline-marker cm-md-link-marker cm-md-link' },
      },
      { from: textEnd + 1, to: urlStart, value: { class: 'cm-md-link-url' } },
    );
    if (urlStart < urlEnd) {
      decorations.push({ from: urlStart, to: urlEnd, value: { class: 'cm-md-link-url' } });
    }
    decorations.push({ from: urlEnd, to, value: { class: 'cm-md-link-url' } });
  }

  const url = view.state.doc.sliceString(urlStart, urlEnd);
  if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) return;

  const enclosingClasses: string[] = [];
  const cursor = syntaxTree(view.state).cursorAt(to);
  do {
    if (cursor.name === 'StrongEmphasis' && cursor.from < to && cursor.to > to) {
      enclosingClasses.push('cm-md-strong');
    } else if (cursor.name === 'Emphasis' && cursor.from < to && cursor.to > to) {
      enclosingClasses.push('cm-md-emphasis');
    } else if (cursor.name === 'Strikethrough' && cursor.from < to && cursor.to > to) {
      enclosingClasses.push('cm-md-strikethrough');
    }
  } while (cursor.parent());

  decorations.push({
    from: to,
    to,
    value: { widget: new ExternalLinkWidget(enclosingClasses.join(' ')), side: 1 },
  });
}

export function decorateImage(
  from: number,
  to: number,
  text: string,
  decorations: PendingDecoration[],
): void {
  if (!text.startsWith('![')) return;
  const altEnd = text.indexOf('](');
  if (altEnd === -1) return;

  const alt = text.slice(2, altEnd);
  let url = text.slice(altEnd + 2, text.length - 1);
  const titleMatch = url.match(/\s+"[^"]*"$/);
  if (titleMatch) url = url.slice(0, -titleMatch[0].length);
  decorations.push({ from, to, value: { widget: new ImageWidget(alt, url, to) } });
}
