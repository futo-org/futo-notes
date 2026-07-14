import { EditorView } from '@codemirror/view';

function forceMeasure(view: EditorView): void {
  (view as unknown as { measure(flush?: boolean): void }).measure();
}

export function warmHeightMap(view: EditorView): { grew: number; steps: number } {
  const scroller = view.scrollDOM;
  const restore = scroller.scrollTop;
  const startHeight = scroller.scrollHeight;
  const docLen = view.state.doc.length;

  let pos = 0; // doc position currently parked at the top of the viewport
  let steps = 0;
  let lastPos = -1;
  for (let i = 0; i < 400; i++) {
    view.dispatch({ effects: EditorView.scrollIntoView(Math.min(pos, docLen), { y: 'start' }) });
    forceMeasure(view);
    steps++;
    if (pos >= docLen) break;
    let nextPos = pos;
    try {
      const vpBottom = scroller.scrollTop + scroller.clientHeight;
      nextPos = view.lineBlockAtHeight(vpBottom).to;
    } catch {
      nextPos = docLen;
    }
    if (nextPos <= pos) nextPos = pos + 1;
    if (nextPos === lastPos) break;
    lastPos = pos;
    pos = Math.min(nextPos, docLen);
  }

  const grew = Math.round(scroller.scrollHeight - startHeight);

  view.dispatch({ effects: EditorView.scrollIntoView(0, { y: 'start' }) });
  forceMeasure(view);
  if (scroller.scrollTop !== restore) {
    scroller.scrollTop = restore;
    forceMeasure(view);
  }

  return { grew, steps };
}
