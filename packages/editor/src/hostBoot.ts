/**
 * How the editor bundle boots itself from its host.
 *
 * The bundle (`editor.html`, built from `src/editor-embed/main.ts`) is loaded
 * by two native WebView hosts that know nothing about each other. Both used to
 * carry their own copy of this boot ritual — apply the theme, suppress the web
 * toolbar, set the content inset, register the image base URL, feed the note
 * universe, push the note text, then declare readiness — in their own order,
 * with their own bridge-version policy and their own hard-coded inset. The two
 * copies drifted, and every fix to one of them shipped twice.
 *
 * The sequence lives here instead. A host sends its whole intent ONCE, as an
 * {@link EditorHostConfig}, and this module decides what to apply and in what
 * order. A shell is left with the things only it can do: creating and
 * reparenting the WebView, forwarding platform events, and its keyboard shims.
 *
 * Everything effectful is injected ({@link EditorHostEffects}), so the boot
 * order, the version policy, the dedupe and the post-renderer-death re-boot are
 * all assertable without a DOM — see `hostBoot.test.ts`.
 */

import { BRIDGE_VERSION, type EditorTheme, type FutoEditorOutboundMessage } from './bridge';

/**
 * Everything a host wants the freshly-loaded editor page to be. Sent once per
 * page load, JSON-serialized, via `FutoEditor.initialize`.
 *
 * Deliberately NOT here: auto-focus. Raising the soft keyboard is the one part
 * of the open path that is irreducibly platform-private (iOS forces it through
 * a swizzled WKContentView focus method, Android has to retry `showSoftInput`
 * until the WebView becomes the IMM's served view), so each shell keeps it and
 * runs it when the bundle reports `initialized`.
 */
export interface EditorHostConfig {
  /**
   * The {@link BRIDGE_VERSION} the host was built against. Compared with the
   * bundle's own — see {@link BridgeVersionMismatchMessage} for why a mismatch
   * is reported rather than enforced.
   */
  bridgeVersion: number;
  languageTag?: string;
  /** Editor color theme. */
  theme: EditorTheme;
  /** The open note's markdown. */
  content: string;
  /** JSON-serialized `BridgeNote[]`; omit when the host has no universe yet. */
  notesJson?: string;
  /**
   * Base URL local `![](f)` images resolve against — iOS `futo-asset:///`,
   * Android `file://<notesRoot>/`. Omit when the host serves no local images.
   */
  imageBaseUrl?: string;
  /** The host renders its own toolbar, so the embed must suppress its web one. */
  nativeToolbar: boolean;
  /**
   * Left/right inset of the note body in CSS px, so it lines up with the
   * shell's own native title field. A per-shell VALUE (iOS's title field and
   * Android's are inset differently), but not per-shell knowledge: the shells
   * no longer need to know which CSS variable carries it, nor that `.cm-line`
   * contributes 6px of its own.
   */
  contentPaddingInlinePx: number;
}

/** The page-level effects {@link createEditorHostBoot} drives. */
export interface EditorHostEffects {
  applyContentPadding(px: number): void;
  applyLanguage(languageTag: string): void;
  applyNativeToolbar(enabled: boolean): void;
  applyTheme(theme: EditorTheme): void;
  applyImageBaseUrl(base: string): void;
  applyNotes(notesJson: string): void;
  applyContent(markdown: string): void;
  /** The live document text, for {@link EditorHostBoot.setContent}'s guard. */
  readContent(): string;
  post(message: FutoEditorOutboundMessage): void;
}

/**
 * The bundle's host-facing state: one boot entry point plus the incremental
 * updates a host sends for the rest of the page's life. They live together
 * because {@link EditorHostBoot.initialize} establishes the state the setters
 * then dedupe against.
 */
export interface EditorHostBoot {
  /** Apply a whole {@link EditorHostConfig} (JSON) — the boot sequence. */
  initialize(configJson: string): void;
  setLanguage(languageTag: string): void;
  setTheme(theme: EditorTheme): void;
  setContent(markdown: string): void;
  setNotes(notesJson: string): void;
  setImageBaseUrl(base: string): void;
}

function isEditorTheme(value: unknown): value is EditorTheme {
  return value === 'light' || value === 'dark';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/**
 * Parse and validate a host config, returning `null` for anything that isn't
 * one. Hosts build this JSON in their own code, so a rejection is a host bug —
 * see {@link createEditorHostBoot} for how loudly it fails.
 */
export function parseEditorHostConfig(configJson: string): EditorHostConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.bridgeVersion !== 'number') return null;
  if (!isEditorTheme(candidate.theme)) return null;
  if (typeof candidate.content !== 'string') return null;
  if (typeof candidate.nativeToolbar !== 'boolean') return null;
  if (typeof candidate.contentPaddingInlinePx !== 'number') return null;
  if (!isOptionalString(candidate.notesJson)) return null;
  if (!isOptionalString(candidate.imageBaseUrl)) return null;
  if (!isOptionalString(candidate.languageTag)) return null;

  return {
    bridgeVersion: candidate.bridgeVersion,
    languageTag: candidate.languageTag,
    theme: candidate.theme,
    content: candidate.content,
    notesJson: candidate.notesJson,
    imageBaseUrl: candidate.imageBaseUrl,
    nativeToolbar: candidate.nativeToolbar,
    contentPaddingInlinePx: candidate.contentPaddingInlinePx,
  };
}

/**
 * Build the bundle's host-facing boot state over `effects`.
 *
 * `bundleVersion` is injectable only so a test can drive a mismatch; production
 * always uses {@link BRIDGE_VERSION}.
 */
export function createEditorHostBoot(
  effects: EditorHostEffects,
  bundleVersion: number = BRIDGE_VERSION,
): EditorHostBoot {
  // Last value pushed for each setting the host can update after boot. Content
  // is absent on purpose: the user types into the document, so the only honest
  // reference for "is this a change?" is the live document, not what we last
  // received.
  let appliedTheme: EditorTheme | null = null;
  let appliedLanguageTag: string | null = null;
  let appliedNotesJson: string | null = null;
  let appliedImageBaseUrl: string | null = null;

  return {
    initialize(configJson: string): void {
      const config = parseEditorHostConfig(configJson);
      if (!config) {
        throw new Error('FutoEditor.initialize: malformed EditorHostConfig');
      }

      if (config.bridgeVersion !== bundleVersion) {
        effects.post({
          type: 'bridgeVersionMismatch',
          hostVersion: config.bridgeVersion,
          bundleVersion,
        });
        // Deliberately fall through and boot anyway — see
        // BridgeVersionMismatchMessage in bridge.ts.
      }

      // Order matters, and this is the only place it is decided:
      //   1-3 settle layout, chrome and color BEFORE any text is on screen, so
      //       the first paint is already correct rather than reflowing.
      //   4-5 land before the content because the content push preloads its own
      //       image dimensions and resolves its own wikilink decorations; with
      //       the base URL and the note universe already in place that happens
      //       on the first render instead of needing a second pass.
      //   6   the note text, last — the frame the user is waiting for.
      if (config.languageTag !== undefined) effects.applyLanguage(config.languageTag);
      effects.applyContentPadding(config.contentPaddingInlinePx);
      effects.applyNativeToolbar(config.nativeToolbar);
      effects.applyTheme(config.theme);
      if (config.imageBaseUrl !== undefined) effects.applyImageBaseUrl(config.imageBaseUrl);
      if (config.notesJson !== undefined) effects.applyNotes(config.notesJson);
      effects.applyContent(config.content);

      appliedTheme = config.theme;
      appliedLanguageTag = config.languageTag ?? null;
      appliedNotesJson = config.notesJson ?? null;
      appliedImageBaseUrl = config.imageBaseUrl ?? null;

      effects.post({ type: 'initialized', version: bundleVersion });
    },

    setLanguage(languageTag: string): void {
      if (languageTag === appliedLanguageTag) return;
      appliedLanguageTag = languageTag;
      effects.applyLanguage(languageTag);
    },

    setTheme(theme: EditorTheme): void {
      if (theme === appliedTheme) return;
      appliedTheme = theme;
      effects.applyTheme(theme);
    },

    setContent(markdown: string): void {
      // Guarded against the LIVE document, not the last push: a host that
      // re-sends content the user has since edited must still overwrite it,
      // and re-sending exactly what is already on screen must not disturb the
      // caret.
      if (markdown === effects.readContent()) return;
      effects.applyContent(markdown);
    },

    setNotes(notesJson: string): void {
      if (notesJson === appliedNotesJson) return;
      appliedNotesJson = notesJson;
      effects.applyNotes(notesJson);
    },

    setImageBaseUrl(base: string): void {
      if (base === appliedImageBaseUrl) return;
      appliedImageBaseUrl = base;
      effects.applyImageBaseUrl(base);
    },
  };
}
