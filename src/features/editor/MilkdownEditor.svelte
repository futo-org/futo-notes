<script lang="ts">
  /*
   * SPIKE — Milkdown (ProseMirror) WYSIWYG editor for the native embedded host.
   *
   * Quick-and-dirty drop-in for MarkdownEditor.svelte inside src/editor-embed:
   * it implements the same props + the subset of the exported handle that
   * createFutoEditorApi/EmbedToolbar actually call. `getView()` returns null
   * because there is no CodeMirror view here; every CM-specific caller already
   * guards on that, and toolbar commands route through `exec()` instead.
   *
   * NOT a replacement for the shipping CM6 live-preview editor: Milkdown
   * round-trips markdown through remark, so its serializer normalizes syntax
   * (`*em*` -> `_em_`, list markers, spacing). `getContent()` therefore returns
   * the host's ORIGINAL markdown until the user actually edits, so merely
   * opening a note can never rewrite it on disk.
   */
  import { onMount } from 'svelte';
  import { Editor, defaultValueCtx, editorViewCtx, rootCtx } from '@milkdown/kit/core';
  import {
    commonmark,
    liftListItemCommand,
    sinkListItemCommand,
    toggleEmphasisCommand,
    toggleLinkCommand,
    toggleStrongCommand,
    turnIntoTextCommand,
    wrapInBlockquoteCommand,
    wrapInBulletListCommand,
    wrapInHeadingCommand,
    wrapInOrderedListCommand,
  } from '@milkdown/kit/preset/commonmark';
  import { gfm, toggleStrikethroughCommand } from '@milkdown/kit/preset/gfm';
  import { history } from '@milkdown/kit/plugin/history';
  import { listener, listenerCtx } from '@milkdown/kit/plugin/listener';
  import { clipboard } from '@milkdown/kit/plugin/clipboard';
  import { cursor } from '@milkdown/kit/plugin/cursor';
  import { trailing } from '@milkdown/kit/plugin/trailing';
  import { callCommand, getMarkdown, insert, replaceAll } from '@milkdown/kit/utils';
  import type { EditorView as CodeMirrorView } from '@codemirror/view';
  import type { EditorView as ProseView } from '@milkdown/kit/prose/view';
  import type { Node as ProseNode } from '@milkdown/kit/prose/model';
  import { resolveImageSrc } from './live-preview/images';
  import type { EditorLinkGesture } from './interactions/editorPointerInteractions';

  interface Props {
    content?: string;
    onchange?: (content: string) => void;
    onfocuschange?: (focused: boolean) => void;
    oncompositionend?: () => void;
    oncursorcontext?: (ctx: { onListLine: boolean }) => void;
    scrollParent?: HTMLElement | null;
    nativeShell?: boolean;
    onopenlink?: (title: string, gesture: EditorLinkGesture) => void;
    onopenurl?: (url: string) => void;
  }

  let {
    content = '',
    onchange,
    onfocuschange,
    oncursorcontext,
    onopenurl,
  }: Props = $props();

  let container: HTMLDivElement;
  let editor: Editor | null = null;

  /* The markdown the HOST last handed us, kept verbatim while the document is
   * still exactly what it loaded, so an open/close cycle cannot rewrite a note
   * on disk in Milkdown's normalized syntax. */
  let hostMarkdown: string | null = null;
  /* Milkdown's own serialization of the current doc. */
  let liveMarkdown = '';
  /* Milkdown's serialization of the doc AS LOADED from the host. The listener
   * plugin debounces markdownUpdated by 200ms, so a synchronous "we are
   * applying host content" flag cannot suppress the load echo — comparing
   * against this can. */
  let externalSerialization: string | null = null;
  let pendingContent: string | null = null;
  let onListLine: boolean | null = null;

  function pmView(): ProseView | null {
    if (!editor) return null;
    try {
      return editor.ctx.get(editorViewCtx);
    } catch {
      return null;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function run(command: { key: any }, payload?: unknown): void {
    if (!editor) return;
    editor.action(callCommand(command.key, payload));
    pmView()?.focus();
  }

  /* ---- image srcs -------------------------------------------------------- *
   * Vault images are relative filenames; the native host registers a base URL
   * (createFutoEditorApi -> setLocalImageBaseUrl), and resolveImageSrc owns the
   * mapping. Milkdown renders plain <img src="file.png">, so rewrite after every
   * render instead of teaching the schema about vault paths. */
  function rewriteImageSrcs(): void {
    const root = container;
    if (!root) return;
    for (const img of Array.from(root.querySelectorAll('img'))) {
      const original = img.dataset.futoSrc ?? img.getAttribute('src') ?? '';
      if (!original) continue;
      img.dataset.futoSrc = original;
      const resolved = resolveImageSrc(original);
      if (resolved && img.getAttribute('src') !== resolved) img.setAttribute('src', resolved);
    }
  }

  function enclosingListItem(): { node: ProseNode; pos: number } | null {
    const view = pmView();
    if (!view) return null;
    // `$from` would be the natural name, but Svelte reserves the `$` prefix.
    const at = view.state.doc.resolve(view.state.selection.from);
    for (let depth = at.depth; depth > 0; depth -= 1) {
      const node = at.node(depth);
      if (node.type.name === 'list_item') return { node, pos: at.before(depth) };
    }
    return null;
  }

  function currentHeadingLevel(): number {
    const view = pmView();
    if (!view) return 0;
    const at = view.state.doc.resolve(view.state.selection.from);
    for (let depth = at.depth; depth > 0; depth -= 1) {
      const node = at.node(depth);
      if (node.type.name === 'heading') return Number(node.attrs.level ?? 0);
    }
    return 0;
  }

  function setListItemChecked(value: boolean | null): void {
    const view = pmView();
    const item = enclosingListItem();
    if (!view || !item) return;
    view.dispatch(
      view.state.tr.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked: value }),
    );
  }

  const EXEC: Record<string, () => void> = {
    bold: () => run(toggleStrongCommand),
    italic: () => run(toggleEmphasisCommand),
    strikethrough: () => run(toggleStrikethroughCommand),
    link: () => run(toggleLinkCommand, { href: '' }),
    heading: () => {
      const level = currentHeadingLevel();
      if (level >= 3) run(turnIntoTextCommand);
      else run(wrapInHeadingCommand, level + 1);
    },
    quote: () => run(wrapInBlockquoteCommand),
    'bullet-list': () => run(wrapInBulletListCommand),
    'ordered-list': () => run(wrapInOrderedListCommand),
    'task-list': () => {
      if (!enclosingListItem()) run(wrapInBulletListCommand);
      const current = enclosingListItem()?.node.attrs.checked ?? null;
      setListItemChecked(current === null ? false : null);
      pmView()?.focus();
    },
    indent: () => run(sinkListItemCommand),
    outdent: () => run(liftListItemCommand),
  };

  onMount(() => {
    let disposed = false;

    // Read the initial prop here rather than at the top level: the embed host
    // feeds content through setContent, and a top-level read is a Svelte 5
    // "captures only the initial value" warning.
    if (content) {
      pendingContent = content;
      hostMarkdown = content;
      liveMarkdown = content;
    }
    container.addEventListener('click', handleClick);

    void (async () => {
      const created = await Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, container);
          ctx.set(defaultValueCtx, pendingContent ?? '');

          const listeners = ctx.get(listenerCtx);
          listeners.markdownUpdated((_ctx, markdown) => {
            liveMarkdown = markdown;
            rewriteImageSrcs();
            // The debounced echo of host content we just loaded — not an edit.
            if (externalSerialization !== null && markdown === externalSerialization) return;
            // A genuine user edit: the host's copy is no longer authoritative.
            externalSerialization = null;
            hostMarkdown = null;
            onchange?.(markdown);
          });
          listeners.focus(() => onfocuschange?.(true));
          listeners.blur(() => onfocuschange?.(false));
          listeners.selectionUpdated(() => {
            const inList = enclosingListItem() !== null;
            if (inList === onListLine) return;
            onListLine = inList;
            oncursorcontext?.({ onListLine: inList });
          });
          listeners.mounted(() => rewriteImageSrcs());
        })
        .use(commonmark)
        .use(gfm)
        .use(history)
        .use(listener)
        .use(clipboard)
        .use(cursor)
        .use(trailing)
        .create();

      if (disposed) {
        void created.destroy();
        return;
      }

      editor = created;
      if (pendingContent !== null && pendingContent !== '') {
        applyExternal(pendingContent);
      }
      pendingContent = null;
      rewriteImageSrcs();
    })();

    return () => {
      disposed = true;
      container.removeEventListener('click', handleClick);
      const current = editor;
      editor = null;
      void current?.destroy();
    };
  });

  function readSerialized(): string | null {
    if (!editor) return null;
    try {
      return editor.action(getMarkdown());
    } catch {
      return null;
    }
  }

  function applyExternal(text: string): void {
    if (!editor) return;
    editor.action(replaceAll(text));
    hostMarkdown = text;
    liveMarkdown = text;
    externalSerialization = readSerialized() ?? text;
    rewriteImageSrcs();
  }

  /* Tapping a task-list marker toggles it (Milkdown renders the checkbox state
   * as a `data-checked` attribute; the glyph itself is CSS). */
  function handleClick(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (!target) return;

    const anchor = target.closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href') ?? '';
      if (href) {
        event.preventDefault();
        onopenurl?.(href);
      }
      return;
    }

    const item = target.closest('li[data-checked]') as HTMLElement | null;
    if (!item) return;
    // The ::before glyph is outdented into the list's padding, so a tap on it
    // lands left of the <li> box. Taps on the text itself must not toggle.
    const rect = item.getBoundingClientRect();
    if (event.clientX >= rect.left) return;
    event.preventDefault();
    const view = pmView();
    if (!view) return;
    const pos = view.posAtDOM(item, 0);
    const resolved = view.state.doc.resolve(pos);
    for (let depth = resolved.depth; depth > 0; depth -= 1) {
      const node = resolved.node(depth);
      if (node.type.name !== 'list_item') continue;
      const checked = node.attrs.checked;
      view.dispatch(
        view.state.tr.setNodeMarkup(resolved.before(depth), undefined, {
          ...node.attrs,
          checked: checked ? false : true,
        }),
      );
      return;
    }
  }

  // ---- handle consumed by src/editor-embed ------------------------------- //

  export function setContent(text: string): void {
    if (!editor) {
      pendingContent = text;
      hostMarkdown = text;
      return;
    }
    if (text === hostMarkdown || text === liveMarkdown) return;
    applyExternal(text);
  }

  export function getContent(): string | undefined {
    const live = readSerialized();
    if (live === null) return hostMarkdown ?? liveMarkdown;
    // Only hand back the host's original bytes while the document is still
    // EXACTLY what it loaded; a keystroke inside the listener's debounce window
    // must not be reported as the unmodified note.
    if (hostMarkdown !== null && live === externalSerialization) return hostMarkdown;
    return live;
  }

  export function focus(): void {
    pmView()?.focus();
  }

  export function blur(): void {
    pmView()?.dom.blur();
  }

  export function hasFocus(): boolean {
    return pmView()?.hasFocus() ?? false;
  }

  export function isComposing(): boolean {
    return Boolean(pmView()?.composing);
  }

  export function insertMarkdown(text: string): void {
    if (!editor) return;
    editor.action(insert(text));
    pmView()?.focus();
  }

  export function refreshDecorations(): void {
    rewriteImageSrcs();
  }

  export function resetHistory(): void {
    // Milkdown's history plugin has no public clear; a fresh note is close
    // enough for the spike.
  }

  export function warmScroll(): { grew: number; steps: number } | null {
    return null;
  }

  /** No CodeMirror view exists — every CM-specific caller already guards null. */
  export function getView(): CodeMirrorView | null {
    return null;
  }

  export function exec(commandId: string): boolean {
    const action = EXEC[commandId];
    if (!action) {
      console.warn(`MilkdownEditor.exec: unsupported command '${commandId}'`);
      return false;
    }
    action();
    return true;
  }
</script>

<!-- The click handler is attached in onMount (see handleClick): it fires on
     ProseMirror-generated children, which the markup never sees. -->
<div class="futo-milkdown" bind:this={container}></div>

<style>
  .futo-milkdown {
    height: 100%;
    position: relative;
  }

  :global(.futo-milkdown .milkdown) {
    height: 100%;
  }

  :global(.futo-milkdown .ProseMirror) {
    height: 100%;
    box-sizing: border-box;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior: contain;
    outline: none;
    padding: 14px calc(18px + env(safe-area-inset-right)) max(40vh, 280px)
      calc(18px + env(safe-area-inset-left));
    color: var(--color-text, #0f0f0f);
    font-family: var(--font-sans, system-ui, -apple-system, sans-serif);
    font-size: 17px;
    line-height: 1.55;
    -webkit-text-size-adjust: 100%;
    word-wrap: break-word;
    white-space: pre-wrap;
  }

  :global(.futo-milkdown .ProseMirror > * + *) {
    margin-top: 0.75em;
  }

  :global(.futo-milkdown .ProseMirror h1),
  :global(.futo-milkdown .ProseMirror h2),
  :global(.futo-milkdown .ProseMirror h3),
  :global(.futo-milkdown .ProseMirror h4),
  :global(.futo-milkdown .ProseMirror h5),
  :global(.futo-milkdown .ProseMirror h6) {
    font-weight: 650;
    line-height: 1.25;
    margin-top: 1.2em;
  }

  :global(.futo-milkdown .ProseMirror h1) {
    font-size: 1.7em;
  }
  :global(.futo-milkdown .ProseMirror h2) {
    font-size: 1.4em;
  }
  :global(.futo-milkdown .ProseMirror h3) {
    font-size: 1.2em;
  }

  :global(.futo-milkdown .ProseMirror a) {
    color: var(--color-primary, #f26b1f);
    text-decoration: underline;
  }

  :global(.futo-milkdown .ProseMirror blockquote) {
    border-left: 3px solid var(--color-border, #e5e5e5);
    padding-left: 0.9em;
    color: var(--color-muted, #737373);
  }

  :global(.futo-milkdown .ProseMirror code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em;
    background: var(--color-surface, #f2f2f2);
    border-radius: 4px;
    padding: 0.1em 0.3em;
  }

  :global(.futo-milkdown .ProseMirror pre) {
    background: var(--color-surface, #f2f2f2);
    border-radius: 8px;
    padding: 0.8em;
    overflow-x: auto;
    white-space: pre;
  }

  :global(.futo-milkdown .ProseMirror pre code) {
    background: none;
    padding: 0;
  }

  :global(.futo-milkdown .ProseMirror ul),
  :global(.futo-milkdown .ProseMirror ol) {
    padding-left: 1.4em;
  }

  :global(.futo-milkdown .ProseMirror ul) {
    list-style: disc;
  }
  :global(.futo-milkdown .ProseMirror ol) {
    list-style: decimal;
  }

  :global(.futo-milkdown .ProseMirror li) {
    margin: 0.15em 0;
  }

  :global(.futo-milkdown .ProseMirror li[data-checked]) {
    list-style: none;
    position: relative;
  }

  :global(.futo-milkdown .ProseMirror li[data-checked]::before) {
    content: '☐';
    position: absolute;
    left: -1.15em;
    color: var(--color-muted, #737373);
  }

  :global(.futo-milkdown .ProseMirror li[data-checked='true']::before) {
    content: '☑';
    color: var(--color-primary, #f26b1f);
  }

  :global(.futo-milkdown .ProseMirror hr) {
    border: none;
    border-top: 1px solid var(--color-border, #e5e5e5);
  }

  :global(.futo-milkdown .ProseMirror img) {
    max-width: 100%;
    max-height: 300px;
    border-radius: 6px;
  }

  :global(.futo-milkdown .ProseMirror table) {
    border-collapse: collapse;
    display: block;
    overflow-x: auto;
    max-width: 100%;
  }

  :global(.futo-milkdown .ProseMirror th),
  :global(.futo-milkdown .ProseMirror td) {
    border: 1px solid var(--color-border, #e5e5e5);
    padding: 0.35em 0.6em;
  }

  :global(.futo-milkdown .ProseMirror ::selection) {
    background: var(--color-selection, #ffe4d1);
  }
</style>
