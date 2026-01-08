import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
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

// Performance logging
const PERF_LOGGING = __DEV__ || true;
function logPerf(label: string, startTime?: number) {
  if (!PERF_LOGGING) return;
  if (startTime) {
    console.log(`[PERF:Pool] ${label}: ${Date.now() - startTime}ms`);
  } else {
    console.log(`[PERF:Pool] ${label}`);
  }
}

// Platform-specific font loading
const FONT_BASE_URL = Platform.OS === "android"
  ? "file:///android_asset/fonts"
  : null;

function getFontCSS(): string {
  if (FONT_BASE_URL) {
    return FONTS_CSS_EXTERNAL.replace(/FONT_BASE_URL/g, FONT_BASE_URL);
  }
  return FONTS_CSS_BASE64;
}

// Generate the editor HTML (without content - content injected via message)
function generatePooledEditorHTML(): string {
  const fontCSS = getFontCSS();

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
      --bg: #FAF9F6;
      --surface: #F4F1EC;
      --text-primary: #2C2C2C;
      --text-secondary: #5C5C5C;
      --text-tertiary: #8A8A8A;
      --accent: #3D5A80;
      --accent-light: #4A6FA5;
      --highlight: #8B2635;
      --border: #E8E4DE;
      --border-light: #F0EDE8;
      --separator: #DDD8D0;
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
    }

    #editor { width: 100%; height: 100%; }

    .cm-editor { height: 100%; font-size: 16px; }
    .cm-editor .cm-scroller { padding: 20px; line-height: 1.7; overflow-x: hidden; }
    .cm-editor .cm-content { caret-color: var(--accent); max-width: 680px; }
    .cm-editor.cm-focused { outline: none; }
    .cm-editor .cm-gutters { display: none; }
    .cm-editor .cm-activeLine { background: transparent; }
    .cm-editor .cm-activeLineGutter { background: transparent; }
    .cm-editor .cm-selectionBackground,
    .cm-editor.cm-focused .cm-selectionBackground {
      background: rgba(61, 90, 128, 0.12) !important;
    }

    /* Typography */
    .cm-md-h1 { font-family: 'Vollkorn', Georgia, serif; font-size: 2em; line-height: 1.25; font-weight: 700; letter-spacing: -0.02em; margin-top: 0.5em; }
    .cm-md-h2 { font-family: 'Vollkorn', Georgia, serif; font-size: 1.55em; line-height: 1.3; font-weight: 600; letter-spacing: -0.015em; }
    .cm-md-h3 { font-family: 'Vollkorn', Georgia, serif; font-size: 1.3em; line-height: 1.35; font-weight: 600; letter-spacing: -0.01em; }
    .cm-md-h4 { font-family: 'IBM Plex Sans', sans-serif; font-size: 1.1em; line-height: 1.4; font-weight: 600; color: var(--text-secondary); }
    .cm-md-h5 { font-family: 'IBM Plex Sans', sans-serif; font-size: 1em; line-height: 1.5; font-weight: 600; color: var(--text-secondary); }
    .cm-md-h6 { font-family: 'IBM Plex Sans', sans-serif; font-size: 0.9em; line-height: 1.5; font-weight: 600; color: var(--text-tertiary); font-style: italic; }

    /* Inline formatting */
    .cm-md-emphasis { font-style: italic; }
    .cm-md-strong { font-weight: 700; }
    .cm-md-strikethrough { text-decoration: line-through; color: var(--text-tertiary); }
    .cm-md-link { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent-light); }
    .cm-md-code { font-family: 'IBM Plex Mono', monospace; background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.88em; border: 1px solid var(--border); }

    /* Code blocks */
    .cm-line.cm-md-codeblock { font-family: 'IBM Plex Mono', monospace; background: var(--code-bg); font-size: 0.88em; padding-left: 12px; padding-right: 12px; margin-left: -12px; margin-right: -12px; border-left: 3px solid var(--accent); }
    .cm-line.cm-md-codeblock-single { border-radius: 0 6px 6px 0; padding-top: 12px; padding-bottom: 12px; }
    .cm-line.cm-md-codeblock-first { border-radius: 0 6px 0 0; padding-top: 12px; }
    .cm-line.cm-md-codeblock-middle { border-radius: 0; }
    .cm-line.cm-md-codeblock-last { border-radius: 0 0 6px 0; padding-bottom: 12px; }

    /* Task lists */
    .cm-md-task-checked { text-decoration: line-through; color: var(--text-tertiary); }

    /* Blockquotes */
    .cm-line.cm-md-blockquote { border-left: 3px solid var(--highlight); padding-left: 16px; margin-left: -12px; color: var(--text-secondary); font-style: italic; background: linear-gradient(to right, rgba(139, 38, 53, 0.03), transparent 60%); }
    .cm-line.cm-md-blockquote-2 { border-left: 3px solid var(--highlight); background: linear-gradient(to right, rgba(139, 38, 53, 0.03), transparent 60%); padding-left: 32px; box-shadow: inset 16px 0 0 0 var(--bg), inset 19px 0 0 0 var(--blockquote-border); }
    .cm-line.cm-md-blockquote-3 { border-left: 3px solid var(--highlight); background: linear-gradient(to right, rgba(139, 38, 53, 0.03), transparent 60%); padding-left: 48px; box-shadow: inset 16px 0 0 0 var(--bg), inset 19px 0 0 0 var(--blockquote-border), inset 32px 0 0 0 var(--bg), inset 35px 0 0 0 var(--text-tertiary); }

    /* Horizontal rules */
    .cm-md-hr { height: 1px; background: linear-gradient(to right, transparent, var(--separator) 20%, var(--separator) 80%, transparent); margin: 20px 0; }

    /* Tables */
    .cm-md-table-wrapper { overflow-x: auto; overflow-y: visible; max-width: calc(100vw - 40px); margin: 16px 0; }
    table.cm-md-table { border-collapse: collapse; font-family: 'IBM Plex Mono', monospace; font-size: 0.88em; width: 100%; }
    table.cm-md-table th, table.cm-md-table td { border: 1px solid var(--border); padding: 10px 14px; min-width: 80px; }
    table.cm-md-table th { font-weight: 600; text-align: left; background: var(--surface); color: var(--text-secondary); }
    table.cm-md-table tr:nth-child(even) { background: rgba(244, 241, 236, 0.5); }
    table.cm-md-table code { background: var(--bg); padding: 1px 4px; border-radius: 3px; border: 1px solid var(--border); }
    table.cm-md-table a { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent-light); }
    table.cm-md-table del { color: var(--text-tertiary); }
    .cm-line.cm-md-table-hidden-line { height: 0; overflow: hidden; line-height: 0; }
  </style>
</head>
<body>
  <div id="editor"></div>
  <script>${CODEMIRROR_BUNDLE}</script>
  <script>${EDITOR_SETUP}</script>
</body>
</html>
`;
}

const POOLED_HTML = generatePooledEditorHTML();

interface PooledEditor {
  id: string;
  webViewRef: React.RefObject<WebView | null>;
  isReady: boolean;
  isActive: boolean;
  sendMessage: (message: object) => void;
}

interface WebViewPoolContextValue {
  // Acquire a warm editor for use
  acquireEditor: () => PooledEditor | null;
  // Release editor back to pool
  releaseEditor: (id: string) => void;
  // Set content in an acquired editor
  setContent: (id: string, content: string) => void;
  // Register change handler
  setChangeHandler: (id: string, handler: ((content: string) => void) | null) => void;
  // Focus the editor
  focusEditor: (id: string) => void;
  // Check if pool has warm editors
  hasWarmEditor: boolean;
}

const WebViewPoolContext = createContext<WebViewPoolContextValue | null>(null);

export function useWebViewPool() {
  const context = useContext(WebViewPoolContext);
  if (!context) {
    throw new Error("useWebViewPool must be used within WebViewPoolProvider");
  }
  return context;
}

interface WebViewPoolProviderProps {
  children: ReactNode;
  poolSize?: number;
}

export function WebViewPoolProvider({
  children,
  poolSize = 1,
}: WebViewPoolProviderProps) {
  const [editors, setEditors] = useState<PooledEditor[]>([]);
  const changeHandlersRef = useRef<Map<string, (content: string) => void>>(new Map());
  const initStartTimeRef = useRef<number>(Date.now());

  // Initialize pool on mount
  useEffect(() => {
    initStartTimeRef.current = Date.now();
    logPerf("Pool initializing...");

    const initialEditors: PooledEditor[] = [];
    for (let i = 0; i < poolSize; i++) {
      initialEditors.push({
        id: `editor-${i}`,
        webViewRef: React.createRef<WebView>(),
        isReady: false,
        isActive: false,
        sendMessage: () => {}, // Will be set when WebView mounts
      });
    }
    setEditors(initialEditors);
  }, [poolSize]);

  // Handle messages from WebViews
  const handleMessage = useCallback(
    async (editorId: string, event: WebViewMessageEvent) => {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === "error") {
        console.error(`[Pool:${editorId}] JS error:`, data.message);
      } else if (data.type === "ready") {
        logPerf(`Editor ${editorId} warm`, initStartTimeRef.current);
        setEditors((prev) =>
          prev.map((e) => (e.id === editorId ? { ...e, isReady: true } : e))
        );
      } else if (data.type === "change") {
        const handler = changeHandlersRef.current.get(editorId);
        handler?.(data.content);
      } else if (data.type === "copy") {
        await Clipboard.setStringAsync(data.text);
      } else if (data.type === "paste") {
        const text = await Clipboard.getStringAsync();
        const editor = editors.find((e) => e.id === editorId);
        editor?.sendMessage({ type: "pasteContent", text });
      }
    },
    [editors]
  );

  // Create sendMessage function for each editor
  const createSendMessage = useCallback(
    (webViewRef: React.RefObject<WebView | null>) => (message: object) => {
      webViewRef.current?.injectJavaScript(
        `window.handleRNMessage(${JSON.stringify(JSON.stringify(message))}); true;`
      );
    },
    []
  );

  // Acquire a warm editor
  const acquireEditor = useCallback((): PooledEditor | null => {
    const warmEditor = editors.find((e) => e.isReady && !e.isActive);
    if (warmEditor) {
      logPerf(`Acquired warm editor: ${warmEditor.id}`);
      setEditors((prev) =>
        prev.map((e) => (e.id === warmEditor.id ? { ...e, isActive: true } : e))
      );
      return warmEditor;
    }
    logPerf("No warm editor available");
    return null;
  }, [editors]);

  // Release editor back to pool
  const releaseEditor = useCallback((id: string) => {
    logPerf(`Releasing editor: ${id}`);
    changeHandlersRef.current.delete(id);

    setEditors((prev) =>
      prev.map((e) => {
        if (e.id === id) {
          // Clear content when releasing
          e.sendMessage({ type: "clear" });
          return { ...e, isActive: false };
        }
        return e;
      })
    );
  }, []);

  // Set content in editor
  const setContent = useCallback(
    (id: string, content: string) => {
      const editor = editors.find((e) => e.id === id);
      if (editor) {
        editor.sendMessage({ type: "setContent", content });
      }
    },
    [editors]
  );

  // Set change handler
  const setChangeHandler = useCallback(
    (id: string, handler: ((content: string) => void) | null) => {
      if (handler) {
        changeHandlersRef.current.set(id, handler);
      } else {
        changeHandlersRef.current.delete(id);
      }
    },
    []
  );

  // Focus editor
  const focusEditor = useCallback(
    (id: string) => {
      const editor = editors.find((e) => e.id === id);
      editor?.sendMessage({ type: "focus" });
    },
    [editors]
  );

  const hasWarmEditor = editors.some((e) => e.isReady && !e.isActive);

  const contextValue: WebViewPoolContextValue = {
    acquireEditor,
    releaseEditor,
    setContent,
    setChangeHandler,
    focusEditor,
    hasWarmEditor,
  };

  return (
    <WebViewPoolContext.Provider value={contextValue}>
      {children}
      {/* Render pooled WebViews - hidden until acquired */}
      <View style={styles.poolContainer} pointerEvents="none">
        {editors.map((editor) => (
          <View
            key={editor.id}
            style={[
              styles.pooledWebView,
              editor.isActive && styles.pooledWebViewHidden,
            ]}
          >
            <WebView
              ref={editor.webViewRef}
              source={{ html: POOLED_HTML }}
              style={styles.webview}
              onMessage={(e) => handleMessage(editor.id, e)}
              onLoad={() => {
                // Set up sendMessage when WebView loads
                const sendMessage = createSendMessage(editor.webViewRef);
                setEditors((prev) =>
                  prev.map((e) =>
                    e.id === editor.id ? { ...e, sendMessage } : e
                  )
                );
              }}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              originWhitelist={["*"]}
              scrollEnabled={false}
              androidLayerType="hardware"
              allowFileAccess={true}
              allowUniversalAccessFromFileURLs={true}
            />
          </View>
        ))}
      </View>
    </WebViewPoolContext.Provider>
  );
}

const styles = StyleSheet.create({
  poolContainer: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    overflow: "hidden",
  },
  pooledWebView: {
    width: 400,
    height: 800,
  },
  pooledWebViewHidden: {
    // Keep it rendered but tiny when active (actual WebView moves to note screen)
  },
  webview: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
