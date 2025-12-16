import React, { useRef, useEffect, useCallback } from "react";
import { StyleSheet, Platform } from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import { CODEMIRROR_BUNDLE, FONTS_CSS } from "@/lib/codemirror-bundle-string";

interface CodeMirrorEditorProps {
  value: string;
  onChangeText: (text: string) => void;
  autoFocus?: boolean;
}

const getCodeMirrorHTML = (bundle: string, fonts: string) => `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    ${fonts}
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #fff;
      font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    #editor {
      width: 100%;
      height: 100%;
    }
    .cm-editor {
      height: 100%;
      font-size: 16px;
    }
    .cm-editor .cm-scroller {
      padding: 16px;
      line-height: 1.5;
    }
    .cm-editor .cm-content {
      caret-color: #007AFF;
    }
    .cm-editor.cm-focused {
      outline: none;
    }
    .cm-editor .cm-gutters {
      display: none;
    }
    .cm-editor .cm-activeLine {
      background: transparent;
    }
    .cm-editor .cm-activeLineGutter {
      background: transparent;
    }

    /* Markdown styles */
    .cm-md-h1 { font-size: 1.8em; font-weight: 700; line-height: 1.3; }
    .cm-md-h2 { font-size: 1.5em; font-weight: 700; line-height: 1.3; }
    .cm-md-h3 { font-size: 1.25em; font-weight: 600; line-height: 1.4; }
    .cm-md-h4 { font-size: 1.1em; font-weight: 600; line-height: 1.4; }
    .cm-md-h5 { font-size: 1em; font-weight: 600; line-height: 1.5; }
    .cm-md-h6 { font-size: 0.9em; font-weight: 600; line-height: 1.5; color: #666; }
    .cm-md-emphasis { font-style: italic; }
    .cm-md-strong { font-weight: 700; }
    .cm-md-strikethrough { text-decoration: line-through; color: #888; }
    .cm-md-code {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      background: #f4f4f4;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .cm-md-codeblock {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      background: #f4f4f4;
      font-size: 0.9em;
    }
    .cm-md-link { color: #007AFF; text-decoration: underline; }
    .cm-md-task-checked { text-decoration: line-through; color: #888; }
    .cm-md-blockquote {
      border-left: 3px solid #ddd;
      padding-left: 12px;
      color: #666;
      font-style: italic;
    }
    .cm-md-hr {
      height: 2px;
      background: #ddd;
      margin: 8px 0;
    }
  </style>
</head>
<body>
  <div id="editor"></div>
  <script>${bundle}</script>
  <script>
    const {
      EditorView, Decoration, ViewPlugin, WidgetType, keymap,
      history, historyKeymap, defaultKeymap,
      syntaxTree, ensureSyntaxTree, markdown
    } = window.CM;

    let view;
    let isUpdatingFromRN = false;

    function getCursorLines(view) {
      const lines = new Set();
      if (!view.hasFocus) return lines;
      for (const range of view.state.selection.ranges) {
        const startLine = view.state.doc.lineAt(range.from).number;
        const endLine = view.state.doc.lineAt(range.to).number;
        for (let i = startLine; i <= endLine; i++) {
          lines.add(i);
        }
      }
      return lines;
    }

    function isOnCursorLine(pos, view, cursorLines) {
      const line = view.state.doc.lineAt(pos);
      return cursorLines.has(line.number);
    }

    const hideMarkdownPlugin = ViewPlugin.fromClass(class {
      constructor(view) {
        this.decorations = this.buildDecorations(view);
      }

      update(update) {
        if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view) {
        const decorations = [];
        const cursorLines = getCursorLines(view);
        const tree = ensureSyntaxTree(view.state, view.state.doc.length, 100) || syntaxTree(view.state);
        if (tree.length === 0) return Decoration.none;

        tree.iterate({
          enter: (node) => {
            const { from, to } = node;
            if (isOnCursorLine(from, view, cursorLines)) return;
            const visible = view.visibleRanges.some(r => from < r.to && to > r.from);
            if (!visible) return;

            const type = node.type.name;

            if (type.startsWith('ATXHeading')) {
              const level = type.charAt(type.length - 1);
              const headerMark = node.node.getChild('HeaderMark');
              if (headerMark) {
                decorations.push({
                  from: headerMark.from,
                  to: headerMark.to + 1,
                  value: Decoration.replace({})
                });
              }
              const contentFrom = headerMark ? headerMark.to + 1 : from;
              if (contentFrom < to) {
                decorations.push({
                  from: contentFrom,
                  to: to,
                  value: Decoration.mark({ class: 'cm-md-h' + level })
                });
              }
            }

            else if (type === 'Emphasis') {
              const marks = node.node.getChildren('EmphasisMark');
              marks.forEach(mark => {
                decorations.push({
                  from: mark.from,
                  to: mark.to,
                  value: Decoration.replace({})
                });
              });
              if (marks.length >= 2) {
                decorations.push({
                  from: marks[0].to,
                  to: marks[marks.length - 1].from,
                  value: Decoration.mark({ class: 'cm-md-emphasis' })
                });
              }
            }

            else if (type === 'StrongEmphasis') {
              const marks = node.node.getChildren('EmphasisMark');
              marks.forEach(mark => {
                decorations.push({
                  from: mark.from,
                  to: mark.to,
                  value: Decoration.replace({})
                });
              });
              if (marks.length >= 2) {
                decorations.push({
                  from: marks[0].to,
                  to: marks[marks.length - 1].from,
                  value: Decoration.mark({ class: 'cm-md-strong' })
                });
              }
            }

            else if (type === 'Strikethrough') {
              const marks = node.node.getChildren('StrikethroughMark');
              marks.forEach(mark => {
                decorations.push({
                  from: mark.from,
                  to: mark.to,
                  value: Decoration.replace({})
                });
              });
              if (marks.length >= 2) {
                decorations.push({
                  from: marks[0].to,
                  to: marks[marks.length - 1].from,
                  value: Decoration.mark({ class: 'cm-md-strikethrough' })
                });
              }
            }

            else if (type === 'InlineCode') {
              const marks = node.node.getChildren('CodeMark');
              marks.forEach(mark => {
                decorations.push({
                  from: mark.from,
                  to: mark.to,
                  value: Decoration.replace({})
                });
              });
              if (marks.length >= 2) {
                decorations.push({
                  from: marks[0].to,
                  to: marks[marks.length - 1].from,
                  value: Decoration.mark({ class: 'cm-md-code' })
                });
              }
            }

            else if (type === 'Link') {
              const url = node.node.getChild('URL');
              node.node.getChildren('LinkMark').forEach(mark => {
                decorations.push({
                  from: mark.from,
                  to: mark.to,
                  value: Decoration.replace({})
                });
              });
              if (url) {
                decorations.push({
                  from: url.from - 1,
                  to: url.to + 1,
                  value: Decoration.replace({})
                });
              }
              const linkLabel = node.node.getChild('LinkLabel');
              if (linkLabel) {
                decorations.push({
                  from: linkLabel.from,
                  to: linkLabel.to,
                  value: Decoration.mark({ class: 'cm-md-link' })
                });
              }
            }

            else if (type === 'Blockquote') {
              const quoteMark = node.node.getChild('QuoteMark');
              if (quoteMark) {
                decorations.push({
                  from: quoteMark.from,
                  to: quoteMark.to + 1,
                  value: Decoration.replace({})
                });
              }
              decorations.push({
                from: from,
                to: to,
                value: Decoration.mark({ class: 'cm-md-blockquote' })
              });
            }

            else if (type === 'ListItem') {
              const listMark = node.node.getChild('ListMark');
              if (listMark) {
                decorations.push({
                  from: listMark.from,
                  to: listMark.to,
                  value: Decoration.replace({
                    widget: new class extends WidgetType {
                      toDOM() {
                        const span = document.createElement('span');
                        span.textContent = '•';
                        span.style.marginRight = '4px';
                        return span;
                      }
                    }
                  })
                });
              }
            }

            else if (type === 'Task') {
              const marker = node.node.getChild('TaskMarker');
              if (marker) {
                const markerText = view.state.doc.sliceString(marker.from, marker.to);
                const isChecked = markerText.includes('x') || markerText.includes('X');
                decorations.push({
                  from: marker.from,
                  to: marker.to,
                  value: Decoration.replace({
                    widget: new class extends WidgetType {
                      toDOM() {
                        const span = document.createElement('span');
                        span.textContent = isChecked ? '☑' : '☐';
                        span.style.marginRight = '4px';
                        return span;
                      }
                    }
                  })
                });
                if (isChecked) {
                  decorations.push({
                    from: marker.to,
                    to: node.to,
                    value: Decoration.mark({ class: 'cm-md-task-checked' })
                  });
                }
              }
            }

            else if (type === 'FencedCode') {
              const codeInfo = node.node.getChild('CodeInfo');
              const codeMark = node.node.getChild('CodeMark');
              if (codeMark) {
                const hideEnd = codeInfo ? codeInfo.to : codeMark.to;
                decorations.push({
                  from: codeMark.from,
                  to: hideEnd,
                  value: Decoration.replace({})
                });
              }
              const marks = node.node.getChildren('CodeMark');
              if (marks.length > 1) {
                decorations.push({
                  from: marks[marks.length - 1].from,
                  to: marks[marks.length - 1].to,
                  value: Decoration.replace({})
                });
              }
              decorations.push({
                from: from,
                to: to,
                value: Decoration.mark({ class: 'cm-md-codeblock' })
              });
            }

            else if (type === 'HorizontalRule') {
              decorations.push({
                from: from,
                to: to,
                value: Decoration.replace({
                  widget: new class extends WidgetType {
                    toDOM() {
                      const hr = document.createElement('div');
                      hr.className = 'cm-md-hr';
                      hr.style.height = '2px';
                      hr.style.background = '#ddd';
                      hr.style.margin = '8px 0';
                      return hr;
                    }
                  }
                })
              });
            }
          }
        });

        decorations.sort((a, b) => a.from - b.from || a.to - b.to);
        return Decoration.set(decorations.map(d => d.value.range(d.from, d.to)));
      }
    }, {
      decorations: v => v.decorations
    });

    const cleanTheme = EditorView.theme({
      "&": { height: "100%", fontSize: "16px" },
      ".cm-scroller": { padding: "16px", fontFamily: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif" },
      ".cm-content": { caretColor: "#007AFF" },
      "&.cm-focused": { outline: "none" },
      ".cm-gutters": { display: "none" }
    });

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !isUpdatingFromRN) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'change',
          content: update.state.doc.toString()
        }));
      }
    });

    const clipboardHandler = EditorView.domEventHandlers({
      copy(event, view) {
        const { from, to } = view.state.selection.main;
        const text = view.state.sliceDoc(from, to);
        if (text) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'copy', text }));
        }
        event.preventDefault();
        return true;
      },
      cut(event, view) {
        const { from, to } = view.state.selection.main;
        const text = view.state.sliceDoc(from, to);
        if (text) {
          window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'copy', text }));
          view.dispatch({ changes: { from, to, insert: '' } });
        }
        event.preventDefault();
        return true;
      },
      paste(event) {
        event.preventDefault();
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'paste' }));
        return true;
      }
    });

    function initEditor() {
      document.getElementById('editor').innerHTML = '';
      view = new EditorView({
        doc: '',
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          hideMarkdownPlugin,
          cleanTheme,
          updateListener,
          clipboardHandler,
          EditorView.lineWrapping
        ],
        parent: document.getElementById('editor')
      });
      // Enable mobile keyboard features
      view.contentDOM.setAttribute('autocorrect', 'on');
      view.contentDOM.setAttribute('autocomplete', 'on');
      view.contentDOM.setAttribute('autocapitalize', 'sentences');
      view.contentDOM.setAttribute('spellcheck', 'true');
    }

    function setContent(content) {
      if (!view || view.hasFocus) return;
      isUpdatingFromRN = true;
      const current = view.state.doc.toString();
      if (current !== content) {
        view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
      }
      isUpdatingFromRN = false;
    }

    function insertAtCursor(text) {
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
    }

    window.handleRNMessage = function(message) {
      const data = JSON.parse(message);
      if (data.type === 'init' || data.type === 'update') setContent(data.content || '');
      else if (data.type === 'focus' && view) view.focus();
      else if (data.type === 'pasteContent') insertAtCursor(data.text || '');
    };

    initEditor();
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
  </script>
</body>
</html>
`;

export default function CodeMirrorEditor({
  value,
  onChangeText,
  autoFocus = false,
}: CodeMirrorEditorProps) {
  const webViewRef = useRef<WebView>(null);
  const isReadyRef = useRef(false);
  const lastSentValueRef = useRef<string>("");
  const valueRef = useRef(value);
  const onChangeTextRef = useRef(onChangeText);

  useEffect(() => { valueRef.current = value; }, [value]);
  useEffect(() => { onChangeTextRef.current = onChangeText; }, [onChangeText]);

  const sendMessage = useCallback((message: object) => {
    webViewRef.current?.injectJavaScript(
      `window.handleRNMessage(${JSON.stringify(JSON.stringify(message))}); true;`
    );
  }, []);

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "ready") {
        isReadyRef.current = true;
        sendMessage({ type: "init", content: valueRef.current });
        lastSentValueRef.current = valueRef.current;
        if (autoFocus) setTimeout(() => sendMessage({ type: "focus" }), 100);
      } else if (data.type === "change" && data.content !== lastSentValueRef.current) {
        lastSentValueRef.current = data.content;
        onChangeTextRef.current(data.content);
      } else if (data.type === "copy") {
        await Clipboard.setStringAsync(data.text);
      } else if (data.type === "paste") {
        const text = await Clipboard.getStringAsync();
        sendMessage({ type: "pasteContent", text });
      }
    },
    [autoFocus, sendMessage],
  );

  useEffect(() => {
    if (isReadyRef.current && value !== lastSentValueRef.current) {
      sendMessage({ type: "update", content: value });
      lastSentValueRef.current = value;
    }
  }, [value, sendMessage]);

  return (
    <WebView
      ref={webViewRef}
      source={{ html: getCodeMirrorHTML(CODEMIRROR_BUNDLE, FONTS_CSS) }}
      style={styles.webview}
      onMessage={handleMessage}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      originWhitelist={["*"]}
      scrollEnabled={true}
      showsVerticalScrollIndicator={true}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView={true}
      allowsInlineMediaPlayback={true}
      mixedContentMode="compatibility"
      androidLayerType={Platform.OS === "android" ? "hardware" : undefined}
      allowFileAccess={true}
      allowUniversalAccessFromFileURLs={true}
      textInteractionEnabled={true}
    />
  );
}

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: "#fff",
  },
});
