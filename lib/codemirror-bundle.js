// CodeMirror bundle entry point - bundled by esbuild and inlined into the WebView

import { EditorView, Decoration, ViewPlugin, WidgetType, keymap } from "@codemirror/view";
import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { syntaxTree, ensureSyntaxTree } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";

window.CM = {
  EditorView, Decoration, ViewPlugin, WidgetType, keymap,
  history, historyKeymap, defaultKeymap,
  syntaxTree, ensureSyntaxTree, markdown,
};
