/*
 * The desktop page of `block-drag-bench.mjs`: mounts the real Milkdown editor
 * bare and runs the benchmark (bench.ts) in the system WebKitGTK, through
 * webkitgtk-host.c.
 */
import { mount } from 'svelte';
import '../../../src/styles/app.css';
import MilkdownEditor from '$features/editor/milkdown/MilkdownEditor.svelte';
import type { EditorView } from '@milkdown/kit/prose/view';
import { createBench, type BenchPlan } from './bench';

type EditorHandle = {
  setContent(noteId: string, text: string): void;
  getProseMirrorView(): EditorView | null;
};

const plan = JSON.parse(new URLSearchParams(location.search).get('plan') ?? 'null') as
  (BenchPlan & { layout: 'desktop' | 'embed' }) | null;

document.documentElement.dataset.theme = 'light';
const target = document.getElementById('editor')!;
if (plan?.layout === 'embed') {
  // Out of the desktop shell's scroller, into a full-height box of its own.
  document.body.replaceChildren(target);
  document.body.classList.add('embed-layout');
}
const editor = mount(MilkdownEditor, {
  target,
  props: { content: '' },
}) as unknown as EditorHandle;

/** The host (webkitgtk-host.c) reads exactly one message: the results, or the
 * error that stopped them. */
function post(message: unknown): void {
  const handler = (
    window as unknown as {
      webkit?: { messageHandlers?: { bench?: { postMessage(text: string): void } } };
    }
  ).webkit?.messageHandlers?.bench;
  const text = JSON.stringify(message);
  if (handler) handler.postMessage(text);
  else console.log(text);
}

window.addEventListener('error', (event) => post({ error: `page error: ${event.message}` }));
if (plan) {
  const bench = createBench({
    view: () => editor.getProseMirrorView(),
    setContent: (noteId, text) => editor.setContent(noteId, text),
  });
  bench
    .runPlan(plan)
    .then(post, (error) => post({ error: String((error as Error)?.stack ?? error) }));
}
