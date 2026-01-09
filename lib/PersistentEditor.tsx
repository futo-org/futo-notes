/**
 * PersistentEditor - A single WebView editor that stays warm across navigations
 *
 * Architecture:
 * - One WebView is rendered at the app root and stays initialized
 * - When note screen mounts, it "activates" the editor with content
 * - When note screen unmounts, the editor stays warm but hidden
 * - This eliminates the ~800ms CodeMirror initialization on each note open
 */

import React, {
  createContext,
  useContext,
  useRef,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
import { StyleSheet, View, Platform, LayoutChangeEvent, Dimensions } from "react-native";
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
let initStartTime: number | null = null;

function logPerf(label: string) {
  if (!PERF_LOGGING) return;
  if (initStartTime) {
    console.log(`[PERF:Editor] ${label}: ${Date.now() - initStartTime}ms`);
  } else {
    console.log(`[PERF:Editor] ${label}`);
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

// Generate the editor HTML
function generateEditorHTML(): string {
  const fontCSS = getFontCSS();

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    ${fontCSS}

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

    .cm-md-h1 { font-family: 'Vollkorn', Georgia, serif; font-size: 2em; line-height: 1.25; font-weight: 700; letter-spacing: -0.02em; margin-top: 0.5em; }
    .cm-md-h2 { font-family: 'Vollkorn', Georgia, serif; font-size: 1.55em; line-height: 1.3; font-weight: 600; letter-spacing: -0.015em; }
    .cm-md-h3 { font-family: 'Vollkorn', Georgia, serif; font-size: 1.3em; line-height: 1.35; font-weight: 600; letter-spacing: -0.01em; }
    .cm-md-h4 { font-family: 'Vollkorn', Georgia, serif; font-size: 1.1em; line-height: 1.4; font-weight: 600; color: var(--text-secondary); }
    .cm-md-h5 { font-family: 'Vollkorn', Georgia, serif; font-size: 1em; line-height: 1.5; font-weight: 600; color: var(--text-secondary); }
    .cm-md-h6 { font-family: 'Vollkorn', Georgia, serif; font-size: 0.9em; line-height: 1.5; font-weight: 600; color: var(--text-tertiary); font-style: italic; }

    .cm-md-emphasis { font-style: italic; }
    .cm-md-strong { font-weight: 700; }
    .cm-md-strikethrough { text-decoration: line-through; color: var(--text-tertiary); }
    .cm-md-link { color: var(--accent); text-decoration: none; border-bottom: 1px solid var(--accent-light); }
    .cm-md-code { font-family: 'IBM Plex Mono', monospace; background: var(--code-bg); padding: 2px 6px; border-radius: 4px; font-size: 0.88em; border: 1px solid var(--border); }

    .cm-line.cm-md-codeblock { font-family: 'IBM Plex Mono', monospace; background: var(--code-bg); font-size: 0.88em; padding-left: 12px; padding-right: 12px; margin-left: -12px; margin-right: -12px; border-left: 3px solid var(--accent); }
    .cm-line.cm-md-codeblock-single { border-radius: 0 6px 6px 0; padding-top: 12px; padding-bottom: 12px; }
    .cm-line.cm-md-codeblock-first { border-radius: 0 6px 0 0; padding-top: 12px; }
    .cm-line.cm-md-codeblock-middle { border-radius: 0; }
    .cm-line.cm-md-codeblock-last { border-radius: 0 0 6px 0; padding-bottom: 12px; }

    .cm-md-task-checked { text-decoration: line-through; color: var(--text-tertiary); }

    .cm-line.cm-md-blockquote { border-left: 3px solid var(--highlight); padding-left: 16px; margin-left: -12px; color: var(--text-secondary); font-style: italic; background: linear-gradient(to right, rgba(139, 38, 53, 0.03), transparent 60%); }
    .cm-line.cm-md-blockquote-2 { border-left: 3px solid var(--highlight); background: linear-gradient(to right, rgba(139, 38, 53, 0.03), transparent 60%); padding-left: 32px; box-shadow: inset 16px 0 0 0 var(--bg), inset 19px 0 0 0 var(--blockquote-border); }
    .cm-line.cm-md-blockquote-3 { border-left: 3px solid var(--highlight); background: linear-gradient(to right, rgba(139, 38, 53, 0.03), transparent 60%); padding-left: 48px; box-shadow: inset 16px 0 0 0 var(--bg), inset 19px 0 0 0 var(--blockquote-border), inset 32px 0 0 0 var(--bg), inset 35px 0 0 0 var(--text-tertiary); }

    .cm-md-hr { height: 1px; background: linear-gradient(to right, transparent, var(--separator) 20%, var(--separator) 80%, transparent); margin: 20px 0; }

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

const EDITOR_HTML = { html: generateEditorHTML() };

// Types
interface EditorLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PersistentEditorContextValue {
  isReady: boolean;
  isActive: boolean;
  activate: (content: string, onChange: (content: string) => void, options?: { autoFocus?: boolean }) => void;
  deactivate: () => void;
  setTargetLayout: (layout: EditorLayout | null) => void;
  setOnReady: (callback: (() => void) | undefined) => void;
}

const PersistentEditorContext = createContext<PersistentEditorContextValue | null>(null);

export function usePersistentEditor() {
  const context = useContext(PersistentEditorContext);
  if (!context) {
    throw new Error("usePersistentEditor must be used within PersistentEditorProvider");
  }
  return context;
}

interface PersistentEditorProviderProps {
  children: ReactNode;
}

export function PersistentEditorProvider({ children }: PersistentEditorProviderProps) {
  const webViewRef = useRef<WebView>(null);
  const [isReady, setIsReady] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const [targetLayout, setTargetLayout] = useState<EditorLayout | null>(null);
  const onChangeRef = useRef<((content: string) => void) | null>(null);
  const onReadyCallbackRef = useRef<(() => void) | undefined>(undefined);
  const pendingActivationRef = useRef<{ content: string; autoFocus: boolean } | null>(null);
  const lastContentRef = useRef<string>("");

  // Start timing when provider mounts
  useEffect(() => {
    initStartTime = Date.now();
    logPerf("Provider mounted, initializing editor...");
  }, []);

  const sendMessage = useCallback((message: object) => {
    webViewRef.current?.injectJavaScript(
      `window.handleRNMessage(${JSON.stringify(JSON.stringify(message))}); true;`
    );
  }, []);

  const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
    const data = JSON.parse(event.nativeEvent.data);

    if (data.type === "error") {
      console.error("[PersistentEditor] JS error:", data.message);
    } else if (data.type === "ready") {
      logPerf("WebView ready (CodeMirror initialized)");
      setIsReady(true);

      // If there's a pending activation, do it now
      if (pendingActivationRef.current) {
        const { content, autoFocus } = pendingActivationRef.current;
        pendingActivationRef.current = null;
        sendMessage({ type: "setContent", content });
        if (autoFocus) {
          setTimeout(() => sendMessage({ type: "focus" }), 50);
        }
        // Call the onReady callback
        onReadyCallbackRef.current?.();
      }
    } else if (data.type === "change") {
      if (data.content !== lastContentRef.current) {
        lastContentRef.current = data.content;
        onChangeRef.current?.(data.content);
      }
    } else if (data.type === "copy") {
      await Clipboard.setStringAsync(data.text);
    } else if (data.type === "paste") {
      const text = await Clipboard.getStringAsync();
      sendMessage({ type: "pasteContent", text });
    }
  }, [sendMessage]);

  const activate = useCallback(
    (content: string, onChange: (content: string) => void, options?: { autoFocus?: boolean }) => {
      const activateStartTime = Date.now();
      logPerf("Activating editor...");

      onChangeRef.current = onChange;
      lastContentRef.current = content;
      setIsActive(true);

      if (isReady) {
        sendMessage({ type: "setContent", content });
        if (options?.autoFocus) {
          setTimeout(() => sendMessage({ type: "focus" }), 50);
        }
        // Call onReady callback immediately since editor is already warm
        setTimeout(() => {
          logPerf(`Editor activated (warm): ${Date.now() - activateStartTime}ms from activate()`);
          onReadyCallbackRef.current?.();
        }, 0);
      } else {
        // Queue activation for when ready
        pendingActivationRef.current = { content, autoFocus: options?.autoFocus ?? false };
      }
    },
    [isReady, sendMessage]
  );

  const deactivate = useCallback(() => {
    logPerf("Deactivating editor");
    setIsActive(false);
    onChangeRef.current = null;
    onReadyCallbackRef.current = undefined;
    sendMessage({ type: "clear" });
  }, [sendMessage]);

  const setOnReady = useCallback((callback: (() => void) | undefined) => {
    onReadyCallbackRef.current = callback;
  }, []);

  const contextValue: PersistentEditorContextValue = {
    isReady,
    isActive,
    activate,
    deactivate,
    setTargetLayout,
    setOnReady,
  };

  // Calculate editor position - only show when active AND we have layout
  const showEditor = isActive && targetLayout;

  // Debug: log the layout values
  if (showEditor && targetLayout) {
    console.log(`[PersistentEditor] Layout: x=${targetLayout.x}, y=${targetLayout.y}, w=${targetLayout.width}, h=${targetLayout.height}`);
  }

  const editorStyle = showEditor
    ? {
        position: "absolute" as const,
        left: targetLayout.x,
        top: targetLayout.y,
        width: targetLayout.width,
        height: targetLayout.height,
        zIndex: 10, // On top of transparent content area, but below header (header not overlapped due to y offset)
      }
    : styles.hidden;

  return (
    <PersistentEditorContext.Provider value={contextValue}>
      {children}
      {/* Absolutely positioned WebView overlay */}
      <View style={editorStyle} pointerEvents={showEditor ? "auto" : "none"}>
        <WebView
          ref={webViewRef}
          source={EDITOR_HTML}
          style={styles.webview}
          onMessage={handleMessage}
          onError={(e) => console.error("[PersistentEditor] WebView error:", e.nativeEvent)}
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
    </PersistentEditorContext.Provider>
  );
}

const styles = StyleSheet.create({
  hidden: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
    left: -9999,
    top: -9999,
  },
  webview: {
    flex: 1,
    backgroundColor: colors.background,
  },
});
