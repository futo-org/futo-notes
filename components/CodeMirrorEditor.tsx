import React, { useRef, useEffect, useCallback } from "react";
import { StyleSheet, Platform } from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";

interface CodeMirrorEditorProps {
  value: string;
  onChangeText: (text: string) => void;
  autoFocus?: boolean;
}

const CODEMIRROR_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
  <style>
    * {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #fff;
      font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
    #loading {
      padding: 16px;
      color: #999;
    }
  </style>
</head>
<body>
  <div id="editor"><div id="loading">Loading editor...</div></div>
  <script type="module">
    import {EditorView, basicSetup} from 'https://esm.sh/codemirror@6.0.1';
    import {markdown} from 'https://esm.sh/@codemirror/lang-markdown@6.3.2';

    let view;
    let isUpdatingFromRN = false;

    // Custom theme for clean look
    const cleanTheme = EditorView.theme({
      "&": {
        height: "100%",
        fontSize: "16px"
      },
      ".cm-scroller": {
        fontFamily: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        padding: "16px"
      },
      ".cm-content": {
        caretColor: "#007AFF"
      },
      "&.cm-focused": {
        outline: "none"
      },
      ".cm-gutters": {
        display: "none"
      }
    });

    // Update listener to send changes to React Native
    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !isUpdatingFromRN) {
        const content = update.state.doc.toString();
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'change',
          content: content
        }));
      }
    });

    // Clipboard handling - intercept copy/cut/paste
    const clipboardHandler = EditorView.domEventHandlers({
      copy(event, view) {
        const selection = view.state.sliceDoc(
          view.state.selection.main.from,
          view.state.selection.main.to
        );
        if (selection) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'copy',
            text: selection
          }));
        }
        event.preventDefault();
        return true;
      },
      cut(event, view) {
        const selection = view.state.sliceDoc(
          view.state.selection.main.from,
          view.state.selection.main.to
        );
        if (selection) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'copy',
            text: selection
          }));
          // Delete the selected text
          view.dispatch({
            changes: {
              from: view.state.selection.main.from,
              to: view.state.selection.main.to,
              insert: ''
            }
          });
        }
        event.preventDefault();
        return true;
      },
      paste(event, view) {
        event.preventDefault();
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'paste'
        }));
        return true;
      }
    });

    // Initialize editor
    function initEditor(initialContent = '') {
      // Clear loading message
      document.getElementById('editor').innerHTML = '';

      view = new EditorView({
        doc: initialContent,
        extensions: [
          basicSetup,
          markdown(),
          cleanTheme,
          updateListener,
          clipboardHandler,
          EditorView.lineWrapping
        ],
        parent: document.getElementById('editor')
      });

      // Enable iOS keyboard features (autocorrect, autocomplete, spellcheck)
      const contentEditable = view.contentDOM;
      if (contentEditable) {
        contentEditable.setAttribute('autocorrect', 'on');
        contentEditable.setAttribute('autocomplete', 'on');
        contentEditable.setAttribute('autocapitalize', 'sentences');
        contentEditable.setAttribute('spellcheck', 'true');
      }
    }

    // Set content without re-creating editor
    function setContent(content) {
      if (!view) return;
      isUpdatingFromRN = true;
      const currentContent = view.state.doc.toString();
      if (currentContent !== content) {
        view.dispatch({
          changes: {
            from: 0,
            to: currentContent.length,
            insert: content
          }
        });
      }
      isUpdatingFromRN = false;
    }

    // Insert text at cursor (for paste)
    function insertAtCursor(text) {
      if (!view) return;
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length }
      });
    }

    // Handle messages from React Native
    window.handleRNMessage = function(message) {
      try {
        const data = JSON.parse(message);

        if (data.type === 'init' || data.type === 'update') {
          setContent(data.content || '');
        } else if (data.type === 'focus' && view) {
          view.focus();
        } else if (data.type === 'pasteContent') {
          insertAtCursor(data.text || '');
        }
      } catch (e) {
        console.error('Error handling RN message:', e);
      }
    };

    // Start editor and notify RN
    initEditor('');
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

  // Keep refs in sync
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    onChangeTextRef.current = onChangeText;
  }, [onChangeText]);

  // Send message to WebView
  const sendMessage = useCallback((message: object) => {
    if (webViewRef.current) {
      const js = `window.handleRNMessage(${JSON.stringify(JSON.stringify(message))}); true;`;
      webViewRef.current.injectJavaScript(js);
    }
  }, []);

  // Handle messages from WebView
  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      try {
        const data = JSON.parse(event.nativeEvent.data);

        if (data.type === "ready") {
          isReadyRef.current = true;
          // Send initial content
          sendMessage({ type: "init", content: valueRef.current });
          lastSentValueRef.current = valueRef.current;

          if (autoFocus) {
            setTimeout(() => {
              sendMessage({ type: "focus" });
            }, 100);
          }
        } else if (data.type === "change") {
          // Only update if content actually changed
          if (data.content !== lastSentValueRef.current) {
            lastSentValueRef.current = data.content;
            onChangeTextRef.current(data.content);
          }
        } else if (data.type === "copy") {
          // Copy to system clipboard
          await Clipboard.setStringAsync(data.text);
        } else if (data.type === "paste") {
          // Get from system clipboard and send to WebView
          const text = await Clipboard.getStringAsync();
          sendMessage({ type: "pasteContent", text });
        }
      } catch (e) {
        console.error("Error parsing WebView message:", e);
      }
    },
    [autoFocus, sendMessage]
  );

  // Update WebView when value prop changes externally (not from WebView itself)
  useEffect(() => {
    if (isReadyRef.current && value !== lastSentValueRef.current) {
      sendMessage({ type: "update", content: value });
      lastSentValueRef.current = value;
    }
  }, [value, sendMessage]);

  return (
    <WebView
      ref={webViewRef}
      source={{ html: CODEMIRROR_HTML }}
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
