import React, { useRef, useCallback, useState, useEffect, useMemo } from "react";
import { StyleSheet, View, Platform } from "react-native";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import * as Clipboard from "expo-clipboard";
import {
  CODEMIRROR_BUNDLE,
  EDITOR_SETUP,
  FONTS_CSS_EXTERNAL,
  FONTS_CSS_BASE64,
} from "@/lib/codemirror-bundle-string";
import { colors } from "@/lib/theme";

// Platform-specific font base URL
// Android: file:///android_asset/fonts
// iOS: Uses base64 fallback (file:// paths are more complex on iOS)
const FONT_BASE_URL = Platform.OS === "android"
  ? "file:///android_asset/fonts"
  : null; // Use base64 fallback on iOS

// Get the appropriate font CSS based on platform
function getFontCSS(): string {
  if (FONT_BASE_URL) {
    // Use external fonts with file:// URLs (Android)
    return FONTS_CSS_EXTERNAL.replace(/FONT_BASE_URL/g, FONT_BASE_URL);
  }
  // Fallback to base64 (iOS)
  return FONTS_CSS_BASE64;
}

// Generate HTML with embedded initial content to avoid two-phase initialization
function generateEditorHTML(initialContent: string): string {
  const fontCSS = getFontCSS();
  // Escape content for safe embedding in JavaScript
  const escapedContent = JSON.stringify(initialContent);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    ${fontCSS}

    /* === Base Reset & Quiet Luxury Theme === */
    :root {
      /* Warm paper backgrounds */
      --bg: #FAF9F6;
      --surface: #F4F1EC;

      /* Text hierarchy - soft, not harsh */
      --text-primary: #2C2C2C;
      --text-secondary: #5C5C5C;
      --text-tertiary: #8A8A8A;

      /* Accent - muted slate blue (Things 3 inspired) */
      --accent: #3D5A80;
      --accent-light: #4A6FA5;

      /* Highlight - deep burgundy for emphasis */
      --highlight: #8B2635;

      /* Borders - very subtle warmth */
      --border: #E8E4DE;
      --border-light: #F0EDE8;
      --separator: #DDD8D0;

      /* Code */
      --code-bg: #F4F1EC;
      --blockquote-border: #C4BFB6;
    }

    * { box-sizing: border-box; }

    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: var(--bg);
      font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      color: var(--text-primary);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    #editor {
      width: 100%;
      height: 100%;
    }

    /* === CodeMirror Core === */
    .cm-editor {
      height: 100%;
      font-size: 16px;
    }

    .cm-editor .cm-scroller {
      padding: 20px;
      line-height: 1.7;
      overflow-x: hidden;
    }

    .cm-editor .cm-content {
      caret-color: var(--accent);
      max-width: 680px;
    }

    .cm-editor.cm-focused { outline: none; }
    .cm-editor .cm-gutters { display: none; }
    .cm-editor .cm-activeLine { background: transparent; }
    .cm-editor .cm-activeLineGutter { background: transparent; }

    .cm-editor .cm-selectionBackground,
    .cm-editor.cm-focused .cm-selectionBackground {
      background: rgba(61, 90, 128, 0.12) !important;
    }

    /* === Typography - Headings (Vollkorn) === */
    .cm-md-h1 {
      font-family: 'Vollkorn', Georgia, 'Times New Roman', serif;
      font-size: 2em;
      line-height: 1.25;
      font-weight: 700;
      color: var(--text-primary);
      letter-spacing: -0.02em;
      margin-top: 0.5em;
    }

    .cm-md-h2 {
      font-family: 'Vollkorn', Georgia, 'Times New Roman', serif;
      font-size: 1.55em;
      line-height: 1.3;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.015em;
    }

    .cm-md-h3 {
      font-family: 'Vollkorn', Georgia, 'Times New Roman', serif;
      font-size: 1.3em;
      line-height: 1.35;
      font-weight: 600;
      color: var(--text-primary);
      letter-spacing: -0.01em;
    }

    .cm-md-h4 {
      font-family: 'Vollkorn', Georgia, 'Times New Roman', serif;
      font-size: 1.1em;
      line-height: 1.4;
      font-weight: 600;
      color: var(--text-secondary);
      letter-spacing: -0.01em;
    }

    .cm-md-h5 {
      font-family: 'Vollkorn', Georgia, 'Times New Roman', serif;
      font-size: 1em;
      line-height: 1.5;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .cm-md-h6 {
      font-family: 'Vollkorn', Georgia, 'Times New Roman', serif;
      font-size: 0.9em;
      line-height: 1.5;
      font-weight: 600;
      color: var(--text-tertiary);
      font-style: italic;
    }

    /* === Inline Formatting === */
    .cm-md-emphasis {
      font-style: italic;
      color: var(--text-primary);
    }

    .cm-md-strong {
      font-weight: 700;
      color: var(--text-primary);
    }

    .cm-md-strikethrough {
      text-decoration: line-through;
      color: var(--text-tertiary);
    }

    /* === Links - Editorial Blue === */
    .cm-md-link {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px solid var(--accent-light);
      transition: border-color 0.15s ease;
    }

    /* === Inline Code === */
    .cm-md-code {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.88em;
      border: 1px solid var(--border);
    }

    /* === Code Blocks === */
    .cm-line.cm-md-codeblock {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      background: var(--code-bg);
      font-size: 0.88em;
      padding-left: 12px;
      padding-right: 12px;
      margin-left: -12px;
      margin-right: -12px;
      border-left: 3px solid var(--accent);
    }

    .cm-line.cm-md-codeblock-single {
      border-radius: 0 6px 6px 0;
      padding-top: 12px;
      padding-bottom: 12px;
    }

    .cm-line.cm-md-codeblock-first {
      border-radius: 0 6px 0 0;
      padding-top: 12px;
    }

    .cm-line.cm-md-codeblock-middle {
      border-radius: 0;
    }

    .cm-line.cm-md-codeblock-last {
      border-radius: 0 0 6px 0;
      padding-bottom: 12px;
    }

    /* === Task Lists === */
    .cm-md-task-checked {
      text-decoration: line-through;
      color: var(--text-tertiary);
    }

    /* === Blockquotes - Literary Style === */
    .cm-line.cm-md-blockquote {
      border-left: 3px solid var(--highlight);
      padding-left: 16px;
      margin-left: -12px;
      color: var(--text-secondary);
      font-style: italic;
      background: linear-gradient(to right, rgba(139, 38, 53, 0.03), transparent 60%);
    }

    .cm-line.cm-md-blockquote-2 {
      border-left: 3px solid var(--highlight);
      background: linear-gradient(to right, rgba(139, 38, 53, 0.03), transparent 60%);
      padding-left: 32px;
      box-shadow: inset 16px 0 0 0 var(--bg), inset 19px 0 0 0 var(--blockquote-border);
    }

    .cm-line.cm-md-blockquote-3 {
      border-left: 3px solid var(--highlight);
      background: linear-gradient(to right, rgba(139, 38, 53, 0.03), transparent 60%);
      padding-left: 48px;
      box-shadow: inset 16px 0 0 0 var(--bg), inset 19px 0 0 0 var(--blockquote-border),
                  inset 32px 0 0 0 var(--bg), inset 35px 0 0 0 var(--text-tertiary);
    }

    /* === Horizontal Rules === */
    .cm-md-hr {
      height: 1px;
      background: linear-gradient(to right, transparent, var(--separator) 20%, var(--separator) 80%, transparent);
      margin: 20px 0;
    }

    /* === Tables === */
    .cm-md-table-wrapper {
      overflow-x: auto;
      overflow-y: visible;
      max-width: calc(100vw - 40px);
      margin: 16px 0;
    }

    table.cm-md-table {
      border-collapse: collapse;
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      font-size: 0.88em;
      width: 100%;
    }

    table.cm-md-table th,
    table.cm-md-table td {
      border: 1px solid var(--border);
      padding: 10px 14px;
      min-width: 80px;
    }

    table.cm-md-table th {
      font-weight: 600;
      text-align: left;
      background: var(--surface);
      color: var(--text-secondary);
    }

    table.cm-md-table tr:nth-child(even) {
      background: rgba(244, 241, 236, 0.5);
    }

    table.cm-md-table code {
      background: var(--bg);
      padding: 1px 4px;
      border-radius: 3px;
      border: 1px solid var(--border);
    }

    table.cm-md-table a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px solid var(--accent-light);
    }

    table.cm-md-table del {
      color: var(--text-tertiary);
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
  <script>window.INITIAL_CONTENT = ${escapedContent};</script>
  <script>${CODEMIRROR_BUNDLE}</script>
  <script>${EDITOR_SETUP}</script>
</body>
</html>
`;
}

interface CodeMirrorEditorProps {
  initialContent: string;
  onChange: (content: string) => void;
  autoFocus?: boolean;
  onReady?: () => void;
}

export function CodeMirrorEditor({
  initialContent,
  onChange,
  autoFocus = false,
  onReady,
}: CodeMirrorEditorProps) {
  const webViewRef = useRef<WebView>(null);
  const [isReady, setIsReady] = useState(false);
  const onChangeRef = useRef(onChange);
  const onReadyRef = useRef(onReady);
  const lastSentValueRef = useRef(initialContent);

  // Keep onReady ref updated
  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  // Generate HTML with embedded content - memoized to avoid regeneration
  // Note: initialContent is intentionally captured only at first render
  // Subsequent content changes are handled via WebView messages, not HTML regeneration
  const webViewSource = useMemo(
    () => ({ html: generateEditorHTML(initialContent) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [] // Empty deps intentional - only generate once with initial content
  );

  // Keep onChange ref updated
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const sendMessage = useCallback((message: object) => {
    webViewRef.current?.injectJavaScript(
      `window.handleRNMessage(${JSON.stringify(JSON.stringify(message))}); true;`
    );
  }, []);

  const handleMessage = useCallback(
    async (event: WebViewMessageEvent) => {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "error") {
        console.error("[Editor] JavaScript error:", data.message);
        console.error("[Editor] Stack:", data.stack);
      } else if (data.type === "ready") {
        setIsReady(true);
        onReadyRef.current?.();
      } else if (
        data.type === "change" &&
        data.content !== lastSentValueRef.current
      ) {
        lastSentValueRef.current = data.content;
        onChangeRef.current(data.content);
      } else if (data.type === "copy") {
        await Clipboard.setStringAsync(data.text);
      } else if (data.type === "paste") {
        const text = await Clipboard.getStringAsync();
        sendMessage({ type: "pasteContent", text });
      }
    },
    [sendMessage]
  );

  // Auto-focus when ready (content is already embedded in HTML)
  useEffect(() => {
    if (isReady && autoFocus) {
      // Small delay to ensure editor is fully initialized
      setTimeout(() => sendMessage({ type: "focus" }), 50);
    }
  }, [isReady, sendMessage, autoFocus]);

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={webViewSource}
        style={styles.webview}
        onMessage={handleMessage}
        onError={(e) => console.error("[Editor] WebView error:", e.nativeEvent)}
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
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  webview: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
