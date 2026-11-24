/* An ordered list marker's drawn width, which desktopEditor.css needs to start the item's text
 * right after a number wider than the indent: a line's padding cannot follow its marker's box
 * in CSS. Measured on a canvas (no layout) in the editor's own font, once per marker. */

const EDITOR = '.desktop-editor';
const MARKER_WIDTH = '--marker-width';

let canvas: CanvasRenderingContext2D | null | undefined;
let font = '';
const widths = new Map<string, number>();

/** The editor's body font, as a canvas reads it; empty until an editor is in the page. */
function editorFont(): string {
  if (font) return font;
  const editor = document.querySelector(EDITOR);
  if (!editor) return '';
  const style = getComputedStyle(editor);
  font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return font;
}

/** `marker`'s width in CSS px, or null where nothing can measure it (no editor yet, or no
 *  canvas). */
export function markerWidth(marker: string): number | null {
  const known = widths.get(marker);
  if (known !== undefined) return known;
  const face = editorFont();
  if (!face) return null;
  if (canvas === undefined) canvas = document.createElement('canvas').getContext('2d');
  if (!canvas) return null;
  canvas.font = face;
  const width = Math.ceil(canvas.measureText(marker).width * 100) / 100;
  widths.set(marker, width);
  return width;
}

/** Give `line` its ordered `marker`'s width, or none for a line without one. */
export function setMarkerWidth(line: HTMLElement, marker: string | null): void {
  const width = marker === null ? null : markerWidth(marker);
  const value = width === null ? '' : `${width}px`;
  if (line.style.getPropertyValue(MARKER_WIDTH) === value) return;
  if (value) line.style.setProperty(MARKER_WIDTH, value);
  else line.style.removeProperty(MARKER_WIDTH);
}

// A font face that finishes loading changes every width measured in its fallback.
document.fonts?.addEventListener('loadingdone', () => {
  font = '';
  widths.clear();
  for (const marker of document.querySelectorAll<HTMLElement>(`${EDITOR} .marker.ordered`)) {
    if (marker.parentElement) setMarkerWidth(marker.parentElement, marker.dataset.marker ?? null);
  }
});
