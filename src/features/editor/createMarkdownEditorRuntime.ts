import { acceptCompletion, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { keymap, drawSelection, EditorView, type ViewUpdate } from '@codemirror/view';

import { isIOS } from '$lib/platform';
import { openExternalUrl } from '$lib/platform/openExternalUrl';

import { markdownEditorLanguageExtensions } from './codeMirrorMarkdown';
import { cursorMotionKeymap } from './cursorMotion';
import { editorHasDomFocus } from './editorDomFocus';
import {
  editorPointerInteractions,
  type EditorLinkGesture,
  type EditorPointerProfile,
} from './interactions/editorPointerInteractions';
import { EditorScrollAnchoring } from './interactions/scrollAnchoring';
import { interactiveTableEditor } from './table/interactiveTableEditor';
import { imagePasteHandler } from './imagePaste';
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
  openWikilink: (title: string, gesture: EditorLinkGesture) => void;
}

function hostSeesFocus(view: EditorView): boolean {
  return editorHasDomFocus(view, isIOS);
}

export function createMarkdownEditorRuntime(options: CreateMarkdownEditorRuntimeOptions) {
  let changeAnimationFrame = 0;
  const pointerProfile: EditorPointerProfile = !options.nativeShell
    ? isIOS
      ? 'browser-ios'
      : 'desktop'
    : isIOS
      ? 'native-ios'
      : 'native-android';
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
    editorPointerInteractions({
      profile: pointerProfile,
      activateLink: ({ target, gesture }) => {
        if (target.kind === 'wikilink') {
          options.openWikilink(target.title, gesture);
          return;
        }
        const onOpenUrl = options.getOnOpenUrl();
        if (onOpenUrl) onOpenUrl(target.url);
        else openExternalUrl(target.url);
      },
      onWindowBlur: () => options.getOnFocusChange()?.(false),
    }),
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
      if (update.focusChanged) options.getOnFocusChange()?.(hostSeesFocus(update.view));
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

  return {
    extensions,
    scrollAnchoring,
    destroy,
    editorHasDomFocus: hostSeesFocus,
  };
}
