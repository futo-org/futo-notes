import React, { useRef, useEffect, useCallback } from "react";
import { StyleSheet, Platform } from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import { CODEMIRROR_BUNDLE, EDITOR_SETUP, FONTS_CSS } from "@/lib/codemirror-bundle-string";

interface CodeMirrorEditorProps {
  value: string;
  onChangeText: (text: string) => void;
  autoFocus?: boolean;
}

const getCodeMirrorHTML = (cmBundle: string, editorSetup: string, fonts: string) => `
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
      overflow-x: hidden;
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
    .cm-md-h1 { font-size: 1.8em; line-height: 1.3; font-weight: 600; }
    .cm-md-h2 { font-size: 1.5em; line-height: 1.3; font-weight: 600; }
    .cm-md-h3 { font-size: 1.25em; line-height: 1.4; font-weight: 600; }
    .cm-md-h4 { font-size: 1.1em; line-height: 1.4; font-weight: 600; }
    .cm-md-h5 { font-size: 1em; line-height: 1.5; font-weight: 600; }
    .cm-md-h6 { font-size: 0.9em; line-height: 1.5; font-weight: 600; color: #666; }
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
    /* Code block line decorations */
    .cm-line.cm-md-codeblock {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      background: #f4f4f4;
      font-size: 0.9em;
      padding-left: 8px;
      padding-right: 8px;
      margin-left: -8px;
      margin-right: -8px;
    }
    .cm-line.cm-md-codeblock-single {
      border-radius: 6px;
      padding-top: 8px;
      padding-bottom: 8px;
    }
    .cm-line.cm-md-codeblock-first {
      border-radius: 6px 6px 0 0;
      padding-top: 8px;
    }
    .cm-line.cm-md-codeblock-middle {
      border-radius: 0;
    }
    .cm-line.cm-md-codeblock-last {
      border-radius: 0 0 6px 6px;
      padding-bottom: 8px;
    }
    .cm-md-link { color: #007AFF; text-decoration: underline; }
    .cm-md-task-checked { text-decoration: line-through; color: #888; }
    /* Blockquote line decorations */
    .cm-line.cm-md-blockquote {
      border-left: 3px solid #ddd;
      padding-left: 12px;
      margin-left: -8px;
      color: #666;
      font-style: italic;
    }
    .cm-line.cm-md-blockquote-2 {
      background: linear-gradient(to right, transparent 12px, #ccc 12px, #ccc 15px, transparent 15px);
      padding-left: 27px;
    }
    .cm-line.cm-md-blockquote-3 {
      background: linear-gradient(to right,
        transparent 12px, #ccc 12px, #ccc 15px,
        transparent 15px, transparent 27px, #bbb 27px, #bbb 30px, transparent 30px);
      padding-left: 42px;
    }
    .cm-md-hr {
      height: 2px;
      background: #ddd;
      margin: 8px 0;
    }
    /* Table styling */
    .cm-md-table-wrapper {
      overflow-x: auto;
      overflow-y: visible;
      max-width: calc(100vw - 32px);
      margin: 4px 0;
    }
    table.cm-md-table {
      border-collapse: collapse;
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 0.9em;
    }
    table.cm-md-table th,
    table.cm-md-table td {
      border: 1px solid #ddd;
      padding: 4px 8px;
      min-width: 70px;
    }
    table.cm-md-table th {
      font-weight: 600;
      text-align: left;
    }
    table.cm-md-table code {
      background: #f4f4f4;
      padding: 1px 4px;
      border-radius: 3px;
    }
    table.cm-md-table a {
      color: #007AFF;
      text-decoration: underline;
    }
    table.cm-md-table del {
      color: #888;
    }
    .cm-line.cm-md-table-hidden-line {
      height: 0;
      overflow: hidden;
      line-height: 0;
    }
  </style>
</head>
<body>
  <div id="editor"></div>
  <script>${cmBundle}</script>
  <script>${editorSetup}</script>
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
      source={{ html: getCodeMirrorHTML(CODEMIRROR_BUNDLE, EDITOR_SETUP, FONTS_CSS) }}
      style={styles.webview}
      onMessage={handleMessage}
      javaScriptEnabled={true}
      domStorageEnabled={true}
      originWhitelist={["*"]}
      scrollEnabled={false}
      showsVerticalScrollIndicator={false}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView={true}
      allowsInlineMediaPlayback={true}
      mixedContentMode="compatibility"
      androidLayerType={Platform.OS === "android" ? "hardware" : undefined}
      allowFileAccess={true}
      allowUniversalAccessFromFileURLs={true}
      textInteractionEnabled={true}
      nestedScrollEnabled={true}
      overScrollMode="never"
    />
  );
}

const styles = StyleSheet.create({
  webview: {
    flex: 1,
    backgroundColor: "#fff",
  },
});
