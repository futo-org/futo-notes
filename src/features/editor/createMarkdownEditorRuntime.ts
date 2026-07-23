import { acceptCompletion, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { keymap, drawSelection, EditorView, type ViewUpdate } from '@codemirror/view';

import { isIOS } from '$lib/platform';
import { openExternalUrl } from '$lib/platform/openExternalUrl';

import { markdownEditorLanguageExtensions } from './codeMirrorMarkdown';
import { cursorMotionKeymap } from './cursorMotion';
import { EditorCaretInteractions } from './interactions/caretInteractions';
import { EditorLinkInteractions } from './interactions/linkInteractions';
import { EditorScrollAnchoring } from './interactions/scrollAnchoring';
import { interactiveTableEditor } from './table/interactiveTableEditor';
import { imagePasteHandler } from './imagePaste';
import { iosTapFocus } from './iosTapFocus';
import { listContinuationKeymap, orderedListRenumber } from './listContinuation';
import { autoLinkHighlight } from './links/autolinks';
import { liveMarkdownTransform } from './liveMarkdownTransform';
import { isListLine, toggleBold, toggleItalic, toggleStrikethrough } from './markdownToolbar';
import { selectionToolbar } from './editorUX/selectionToolbar';
import { slashMenu } from './editorUX/slashMenu';
import { wikilinkAutocomplete } from './wikilinkAutocomplete';

interface CreateMarkdownEditorRuntimeOptions {
  getOnChange: () => ((content: string) => void) | undefined;
  getOnCursorContext: () => ((context: { onListLine: boolean }) => void) | undefined;
  getOnFocusChange: () => ((focused: boolean) => void) | undefined;
  getOnOpenUrl: () => ((url: string) => void) | undefined;
  getView: () => EditorView | null;
  nativeShell: boolean;
  onEditorContentChange: () => void;
  openWikilink: (title: string, event: MouseEvent) => void;
}

function editorHasDomFocus(view: EditorView): boolean {
  const activeElement = document.activeElement;
  return view.hasFocus || activeElement === view.contentDOM || view.dom.contains(activeElement);
}

export function createMarkdownEditorRuntime(options: CreateMarkdownEditorRuntimeOptions) {
  let changeAnimationFrame = 0;
  const linkInteractions = new EditorLinkInteractions({
    openWikilink: options.openWikilink,
    openExternalUrl: (url) => {
      const onOpenUrl = options.getOnOpenUrl();
      if (onOpenUrl) onOpenUrl(url);
      else openExternalUrl(url);
    },
  });
  const caretInteractions = new EditorCaretInteractions({
    nativeShell: options.nativeShell,
    isIOS,
    getView: options.getView,
    hasPendingExternalLink: () => linkInteractions.hasPendingExternalLink,
  });
  const scrollAnchoring = new EditorScrollAnchoring(options.nativeShell);

  const extensions = [
    drawSelection(),
    cursorMotionKeymap,
    listContinuationKeymap,
    orderedListRenumber,
    history(),
    keymap.of([
      { key: 'Mod-b', run: (view) => (toggleBold(view), true) },
      { key: 'Mod-i', run: (view) => (toggleItalic(view), true) },
      { key: 'Mod-Shift-s', run: (view) => (toggleStrikethrough(view), true) },
      { key: 'Tab', run: acceptCompletion },
      indentWithTab,
      ...completionKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    ...markdownEditorLanguageExtensions(),
    liveMarkdownTransform,
    autoLinkHighlight,
    interactiveTableEditor,
    ...(options.nativeShell ? [] : selectionToolbar),
    slashMenu,
    wikilinkAutocomplete(),
    imagePasteHandler,
    ...iosTapFocus({
      enabled: isIOS,
      resolveTapPosition: ({ clientX, clientY, target }, view) =>
        caretInteractions.resolveTapPositionAt(
          clientX,
          clientY,
          view,
          target instanceof Node ? target : null,
          true,
        ),
      shouldIgnoreTap: (target) => {
        const element =
          target instanceof Element ? target : ((target as Node | null)?.parentElement ?? null);
        if (!element) return false;
        const wikilink = element.closest('.cm-md-wikilink');
        if (wikilink) return !wikilink.classList.contains('cm-md-wikilink-broken');
        return Boolean(element.closest('.cm-md-link'));
      },
    }),
    ...caretInteractions.extensions,
    ...linkInteractions.extensions,
    EditorView.contentAttributes.of({
      autocorrect: 'on',
      autocapitalize: 'sentences',
      spellcheck: 'false',
      enterkeyhint: 'return',
    }),
    EditorView.lineWrapping,
    EditorView.theme({
      '&': { height: 'auto', fontSize: '18px' },
      '.cm-content': { padding: '0', fontFamily: "'Barlow', system-ui, sans-serif" },
      '.cm-focused': { outline: 'none' },
    }),
    scrollAnchoring.extension,
    EditorView.updateListener.of((update) => {
      const onChange = options.getOnChange();
      if (!update.docChanged || !onChange) return;
      options.onEditorContentChange();
      if (document.visibilityState === 'hidden') {
        if (changeAnimationFrame) cancelAnimationFrame(changeAnimationFrame);
        changeAnimationFrame = 0;
        onChange(update.state.doc.toString());
      } else if (!changeAnimationFrame) {
        changeAnimationFrame = requestAnimationFrame(() => {
          changeAnimationFrame = 0;
          const view = options.getView();
          if (view) options.getOnChange()?.(view.state.doc.toString());
        });
      }
    }),
    EditorView.updateListener.of((update) => {
      if (update.focusChanged) options.getOnFocusChange()?.(editorHasDomFocus(update.view));
    }),
    EditorView.updateListener.of(
      (() => {
        let wasOnListLine = false;
        return (update: ViewUpdate) => {
          if (!update.selectionSet && !update.docChanged) return;
          const line = update.state.doc.lineAt(update.state.selection.main.head);
          const isOnListLine = isListLine(line.text);
          if (isOnListLine === wasOnListLine) return;
          wasOnListLine = isOnListLine;
          options.getOnCursorContext()?.({ onListLine: isOnListLine });
        };
      })(),
    ),
  ];

  function destroy(): void {
    if (changeAnimationFrame) cancelAnimationFrame(changeAnimationFrame);
    changeAnimationFrame = 0;
    scrollAnchoring.destroy();
  }

  return { extensions, linkInteractions, scrollAnchoring, destroy, editorHasDomFocus };
}
