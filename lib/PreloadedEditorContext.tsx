import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
} from "react";
import { StyleSheet, View } from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import {
  CODEMIRROR_BUNDLE,
  EDITOR_SETUP,
  FONTS_CSS,
} from "@/lib/codemirror-bundle-string";

const CODEMIRROR_HTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    ${FONTS_CSS}
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #F5F5F3;
      font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      color: #1C1C1E;
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
      caret-color: #1C1C1E;
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
    .cm-md-h1 { font-size: 1.8em; line-height: 1.3; font-weight: 600; color: #3A3A3C; }
    .cm-md-h2 { font-size: 1.5em; line-height: 1.3; font-weight: 600; color: #424244; }
    .cm-md-h3 { font-size: 1.25em; line-height: 1.4; font-weight: 600; color: #4A4A4D; }
    .cm-md-h4 { font-size: 1.1em; line-height: 1.4; font-weight: 600; color: #525255; }
    .cm-md-h5 { font-size: 1em; line-height: 1.5; font-weight: 600; color: #5B5B5E; }
    .cm-md-h6 { font-size: 0.9em; line-height: 1.5; font-weight: 600; color: #636366; }
    .cm-md-emphasis { font-style: italic; }
    .cm-md-strong { font-weight: 700; }
    .cm-md-strikethrough { text-decoration: line-through; color: #86868B; }
    .cm-md-code {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      background: #E8E8E6;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    /* Code block line decorations */
    .cm-line.cm-md-codeblock {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      background: #E8E8E6;
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
    .cm-md-link { color: #48484A; text-decoration: underline; }
    .cm-md-task-checked { text-decoration: line-through; color: #86868B; }
    /* Blockquote line decorations */
    .cm-line.cm-md-blockquote {
      border-left: 3px solid #C7C7CC;
      padding-left: 12px;
      margin-left: -8px;
      color: #636366;
      font-style: italic;
    }
    .cm-line.cm-md-blockquote-2 {
      background: linear-gradient(to right, transparent 12px, #AEAEB2 12px, #AEAEB2 15px, transparent 15px);
      padding-left: 27px;
    }
    .cm-line.cm-md-blockquote-3 {
      background: linear-gradient(to right,
        transparent 12px, #AEAEB2 12px, #AEAEB2 15px,
        transparent 15px, transparent 27px, #8E8E93 27px, #8E8E93 30px, transparent 30px);
      padding-left: 42px;
    }
    .cm-md-hr {
      height: 2px;
      background: #C7C7CC;
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
      border: 1px solid #C7C7CC;
      padding: 4px 8px;
      min-width: 70px;
    }
    table.cm-md-table th {
      font-weight: 600;
      text-align: left;
    }
    table.cm-md-table code {
      background: #E8E8E6;
      padding: 1px 4px;
      border-radius: 3px;
    }
    table.cm-md-table a {
      color: #48484A;
      text-decoration: underline;
    }
    table.cm-md-table del {
      color: #86868B;
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
  <script>${CODEMIRROR_BUNDLE}</script>
  <script>${EDITOR_SETUP}</script>
</body>
</html>
`;

const WEBVIEW_SOURCE = { html: CODEMIRROR_HTML };

interface EditorState {
  isReady: boolean;
  isVisible: boolean;
  show: (
    content: string,
    onChange: (text: string) => void,
    options?: { autoFocus?: boolean }
  ) => void;
  hide: () => void;
  updateContent: (content: string) => void;
}

const PreloadedEditorContext = createContext<EditorState | null>(null);

export function usePreloadedEditor() {
  const context = useContext(PreloadedEditorContext);
  if (!context) {
    throw new Error(
      "usePreloadedEditor must be used within PreloadedEditorProvider"
    );
  }
  return context;
}

interface PreloadedEditorProviderProps {
  children: React.ReactNode;
}

export function PreloadedEditorProvider({
  children,
}: PreloadedEditorProviderProps) {
  const webViewRef = useRef<WebView>(null);
  const [isReady, setIsReady] = useState(false);
  const [isVisible, setIsVisible] = useState(false);
  const onChangeRef = useRef<((text: string) => void) | null>(null);
  const lastSentValueRef = useRef<string>("");

  const sendMessage = useCallback((message: object) => {
    webViewRef.current?.injectJavaScript(
      `window.handleRNMessage(${JSON.stringify(
        JSON.stringify(message)
      )}); true;`
    );
  }, []);

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "ready") {
        setIsReady(true);
      } else if (
        data.type === "change" &&
        data.content !== lastSentValueRef.current
      ) {
        lastSentValueRef.current = data.content;
        onChangeRef.current?.(data.content);
      } else if (data.type === "copy") {
        await Clipboard.setStringAsync(data.text);
      } else if (data.type === "paste") {
        const text = await Clipboard.getStringAsync();
        sendMessage({ type: "pasteContent", text });
      }
    },
    [sendMessage]
  );

  const show = useCallback(
    (
      content: string,
      onChange: (text: string) => void,
      options?: { autoFocus?: boolean }
    ) => {
      onChangeRef.current = onChange;
      lastSentValueRef.current = content;
      setIsVisible(true);

      if (isReady) {
        sendMessage({ type: "init", content });
        if (options?.autoFocus) {
          setTimeout(() => sendMessage({ type: "focus" }), 100);
        }
      }
    },
    [isReady, sendMessage]
  );

  const hide = useCallback(() => {
    setIsVisible(false);
    onChangeRef.current = null;
    // Clear editor content when hiding
    if (isReady) {
      sendMessage({ type: "init", content: "" });
    }
  }, [isReady, sendMessage]);

  const updateContent = useCallback(
    (content: string) => {
      if (isReady && content !== lastSentValueRef.current) {
        sendMessage({ type: "update", content });
        lastSentValueRef.current = content;
      }
    },
    [isReady, sendMessage]
  );

  const editorState: EditorState = {
    isReady,
    isVisible,
    show,
    hide,
    updateContent,
  };

  return (
    <PreloadedEditorContext.Provider value={editorState}>
      {children}
      <View
        style={[
          styles.webviewContainer,
          isVisible ? styles.visible : styles.hidden,
        ]}
        pointerEvents={isVisible ? "auto" : "none"}
      >
        <WebView
          ref={webViewRef}
          source={WEBVIEW_SOURCE}
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
          androidLayerType="hardware"
          allowFileAccess={true}
          allowUniversalAccessFromFileURLs={true}
          textInteractionEnabled={true}
          nestedScrollEnabled={true}
          overScrollMode="never"
        />
      </View>
    </PreloadedEditorContext.Provider>
  );
}

const styles = StyleSheet.create({
  webviewContainer: {
    position: "absolute",
    top: 85, // Standard Android header height
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#F5F5F3",
  },
  visible: {
    opacity: 1,
    zIndex: 10,
  },
  hidden: {
    opacity: 0,
    zIndex: -1,
  },
  webview: {
    flex: 1,
    backgroundColor: "#F5F5F3",
  },
});
