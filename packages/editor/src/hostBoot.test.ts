import { describe, it, expect } from 'vitest';
import { BRIDGE_VERSION, type EditorTheme, type FutoEditorOutboundMessage } from './bridge';
import {
  createEditorHostBoot,
  parseEditorHostConfig,
  type EditorHostBoot,
  type EditorHostConfig,
  type EditorHostEffects,
} from './hostBoot';

/**
 * Records every effect in the order it was applied, so a test can assert the
 * boot SEQUENCE and not merely that each step happened. `content` doubles as
 * the live document the setContent guard reads back.
 */
interface RecordedHost {
  boot: EditorHostBoot;
  steps: string[];
  posted: FutoEditorOutboundMessage[];
  setDocument(text: string): void;
}

function recordHost(bundleVersion: number = BRIDGE_VERSION): RecordedHost {
  const steps: string[] = [];
  const posted: FutoEditorOutboundMessage[] = [];
  let document = '';

  const effects: EditorHostEffects = {
    applyContentPadding: (px) => steps.push(`padding:${px}`),
    applyLanguage: (languageTag) => steps.push(`language:${languageTag}`),
    applyNativeToolbar: (enabled) => steps.push(`nativeToolbar:${enabled}`),
    applyTheme: (theme) => steps.push(`theme:${theme}`),
    applyImageBaseUrl: (base) => steps.push(`imageBaseUrl:${base}`),
    applyNotes: (json) => steps.push(`notes:${json}`),
    applyContent: (markdown) => {
      document = markdown;
      steps.push(`content:${markdown}`);
    },
    readContent: () => document,
    post: (message) => posted.push(message),
  };

  return {
    boot: createEditorHostBoot(effects, bundleVersion),
    steps,
    posted,
    setDocument: (text) => {
      document = text;
    },
  };
}

function config(overrides: Partial<EditorHostConfig> = {}): string {
  const base: EditorHostConfig = {
    bridgeVersion: BRIDGE_VERSION,
    languageTag: 'zh-Hans',
    theme: 'light',
    content: '# note',
    notesJson: '[{"id":"a","title":"a","modifiedMs":1}]',
    imageBaseUrl: 'futo-asset:///',
    nativeToolbar: true,
    contentPaddingInlinePx: 14,
  };
  return JSON.stringify({ ...base, ...overrides });
}

describe('editor boot sequence', () => {
  it('applies the whole host config in one canonical order', () => {
    const host = recordHost();

    host.boot.initialize(config());

    expect(host.steps).toEqual([
      'language:zh-Hans',
      'padding:14',
      'nativeToolbar:true',
      'theme:light',
      'imageBaseUrl:futo-asset:///',
      'notes:[{"id":"a","title":"a","modifiedMs":1}]',
      'content:# note',
    ]);
  });

  it('settles layout, chrome and colour before the note text is applied', () => {
    const host = recordHost();

    host.boot.initialize(config());

    const contentStep = host.steps.indexOf('content:# note');
    for (const step of ['language:zh-Hans', 'padding:14', 'nativeToolbar:true', 'theme:light']) {
      expect(host.steps.indexOf(step)).toBeLessThan(contentStep);
    }
  });

  it('registers the image base URL and the note universe before the content', () => {
    // The content push preloads its own image dimensions and resolves its own
    // wikilink decorations; both need these already in place.
    const host = recordHost();

    host.boot.initialize(config());

    const contentStep = host.steps.indexOf('content:# note');
    expect(host.steps.findIndex((s) => s.startsWith('imageBaseUrl:'))).toBeLessThan(contentStep);
    expect(host.steps.findIndex((s) => s.startsWith('notes:'))).toBeLessThan(contentStep);
  });

  it('reports the note is on screen only after every setting is applied', () => {
    const host = recordHost();

    host.boot.initialize(config());

    expect(host.posted).toEqual([{ type: 'initialized', version: BRIDGE_VERSION }]);
    expect(host.steps).toHaveLength(7);
  });

  it('skips the optional settings a host does not supply', () => {
    const host = recordHost();

    host.boot.initialize(
      config({ notesJson: undefined, imageBaseUrl: undefined, languageTag: undefined }),
    );

    expect(host.steps).toEqual([
      'padding:14',
      'nativeToolbar:true',
      'theme:light',
      'content:# note',
    ]);
  });

  it('carries each shell its own content inset instead of a hard-coded one', () => {
    const ios = recordHost();
    const android = recordHost();

    ios.boot.initialize(config({ contentPaddingInlinePx: 14 }));
    android.boot.initialize(config({ contentPaddingInlinePx: 16 }));

    expect(ios.steps[1]).toBe('padding:14');
    expect(android.steps[1]).toBe('padding:16');
  });

  it('lets a host that renders no native toolbar keep the web one', () => {
    const host = recordHost();

    host.boot.initialize(config({ nativeToolbar: false }));

    expect(host.steps).toContain('nativeToolbar:false');
  });
});

describe('bridge version policy', () => {
  it('boots anyway when the host was built against a different version', () => {
    const host = recordHost(7);

    host.boot.initialize(config({ bridgeVersion: 6 }));

    // The editor is the app's core surface: a stale build must not leave it
    // permanently blank.
    expect(host.steps).toContain('content:# note');
    expect(host.posted).toContainEqual({ type: 'initialized', version: 7 });
  });

  it('reports the mismatch with both versions so a shell can log it', () => {
    const host = recordHost(7);

    host.boot.initialize(config({ bridgeVersion: 3 }));

    expect(host.posted[0]).toEqual({
      type: 'bridgeVersionMismatch',
      hostVersion: 3,
      bundleVersion: 7,
    });
  });

  it('stays quiet when the versions agree', () => {
    const host = recordHost();

    host.boot.initialize(config());

    expect(host.posted.map((m) => m.type)).toEqual(['initialized']);
  });

  it('rejects a malformed config loudly rather than booting half-configured', () => {
    const host = recordHost();

    expect(() => host.boot.initialize('not json')).toThrow(/malformed/);
    expect(host.steps).toEqual([]);
    expect(host.posted).toEqual([]);
  });
});

describe('renderer-death recovery', () => {
  it('re-applies every setting when the host re-sends its config', () => {
    // A dead WebView renderer takes the whole page with it. The host reloads
    // the bundle and answers the fresh `ready` with the same config; nothing
    // it holds needs resetting first.
    const host = recordHost();
    host.boot.initialize(config());
    host.steps.length = 0;
    host.posted.length = 0;

    host.boot.initialize(config());

    expect(host.steps).toEqual([
      'language:zh-Hans',
      'padding:14',
      'nativeToolbar:true',
      'theme:light',
      'imageBaseUrl:futo-asset:///',
      'notes:[{"id":"a","title":"a","modifiedMs":1}]',
      'content:# note',
    ]);
    expect(host.posted).toEqual([{ type: 'initialized', version: BRIDGE_VERSION }]);
  });

  it('restores the open note even when the host state never changed', () => {
    const host = recordHost();
    host.boot.initialize(config({ content: 'the open note' }));
    host.setDocument('');
    host.steps.length = 0;

    host.boot.initialize(config({ content: 'the open note' }));

    expect(host.steps).toContain('content:the open note');
  });
});

describe('incremental updates after boot', () => {
  it('reconfigures language only when it changes', () => {
    const host = recordHost();
    host.boot.initialize(config({ languageTag: 'en' }));
    host.steps.length = 0;

    host.boot.setLanguage('en');
    host.boot.setLanguage('zh-Hans');
    host.boot.setLanguage('zh-Hans');

    expect(host.steps).toEqual(['language:zh-Hans']);
  });

  it('ignores a theme the editor already shows', () => {
    const host = recordHost();
    host.boot.initialize(config({ theme: 'light' }));
    host.steps.length = 0;

    host.boot.setTheme('light');

    expect(host.steps).toEqual([]);
  });

  it('applies a theme change', () => {
    const host = recordHost();
    host.boot.initialize(config({ theme: 'light' }));
    host.steps.length = 0;

    host.boot.setTheme('dark');
    host.boot.setTheme('dark');
    host.boot.setTheme('light');

    expect(host.steps).toEqual(['theme:dark', 'theme:light']);
  });

  it('ignores a note universe identical to the one already fed', () => {
    const host = recordHost();
    const universe = '[{"id":"a","title":"a","modifiedMs":1}]';
    host.boot.initialize(config({ notesJson: universe }));
    host.steps.length = 0;

    host.boot.setNotes(universe);
    host.boot.setNotes('[]');
    host.boot.setNotes('[]');

    expect(host.steps).toEqual(['notes:[]']);
  });

  it('ignores an image base URL identical to the one already registered', () => {
    const host = recordHost();
    host.boot.initialize(config({ imageBaseUrl: 'futo-asset:///' }));
    host.steps.length = 0;

    host.boot.setImageBaseUrl('futo-asset:///');
    host.boot.setImageBaseUrl('file:///vault/');

    expect(host.steps).toEqual(['imageBaseUrl:file:///vault/']);
  });

  it('leaves the document alone when the host re-sends what is on screen', () => {
    const host = recordHost();
    host.boot.initialize(config({ content: 'unchanged' }));
    host.steps.length = 0;

    host.boot.setContent('unchanged');

    expect(host.steps).toEqual([]);
  });

  it('overwrites edits the host has decided to replace', () => {
    // The guard reads the LIVE document, so re-sending content the user has
    // since edited still lands — a remembered "last push" would swallow it.
    const host = recordHost();
    host.boot.initialize(config({ content: 'from disk' }));
    host.setDocument('typed by the user');
    host.steps.length = 0;

    host.boot.setContent('from disk');

    expect(host.steps).toEqual(['content:from disk']);
  });
});

describe('parseEditorHostConfig', () => {
  it('accepts a config with only the required fields', () => {
    const parsed = parseEditorHostConfig(
      JSON.stringify({
        bridgeVersion: 7,
        theme: 'dark',
        content: '',
        nativeToolbar: false,
        contentPaddingInlinePx: 16,
      }),
    );

    expect(parsed).toEqual({
      bridgeVersion: 7,
      languageTag: undefined,
      theme: 'dark',
      content: '',
      notesJson: undefined,
      imageBaseUrl: undefined,
      nativeToolbar: false,
      contentPaddingInlinePx: 16,
    });
  });

  it.each([
    ['not json', 'not json'],
    ['a JSON array', '[]'],
    ['a JSON scalar', '42'],
    ['null', 'null'],
    ['an unknown theme', config({ theme: 'sepia' as EditorTheme })],
    ['a missing version', JSON.stringify({ theme: 'light', content: '', nativeToolbar: true })],
    ['a non-numeric inset', config({ contentPaddingInlinePx: '14' as unknown as number })],
    ['a non-string content', config({ content: 0 as unknown as string })],
    ['a non-string notes universe', config({ notesJson: [] as unknown as string })],
    ['a non-string language tag', config({ languageTag: 42 as unknown as string })],
  ])('rejects %s', (_label, json) => {
    expect(parseEditorHostConfig(json)).toBeNull();
  });
});
