import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
  type StreamParser,
} from '@codemirror/language';

/**
 * Code-fence grammars the editor can highlight.
 *
 * `@codemirror/language-data` ships ~128 of these. Importing its manifest puts
 * an `import()` for every one of them in the module graph, so all 128 grammars
 * are emitted into the app bundle — and inlined whole into the single-file
 * native editor bundle, which cannot lazy-load. Naming the grammars here
 * instead keeps the unlisted ones out of the build entirely.
 *
 * A fence in an unlisted language still renders as a code block; it just is not
 * syntax-coloured. Adding one back is a single row.
 *
 * Only the name and its aliases matter here: fence info strings are resolved by
 * `LanguageDescription.matchLanguageName`, which looks at nothing else. The
 * `extensions`/`filename` fields that `language-data` carries for file-based
 * detection would be dead weight.
 */

type Row = [names: string, load: () => Promise<LanguageSupport>];

/**
 * A `@codemirror/legacy-modes` stream parser, wrapped as a language.
 *
 * The caller passes the `import()` itself rather than a module name: a
 * template-literal specifier would make Vite glob every legacy mode back into
 * the bundle, which is exactly what this file exists to avoid.
 */
function legacy(load: () => Promise<Record<string, unknown>>, exportName: string) {
  return () =>
    load().then(
      (m) => new LanguageSupport(StreamLanguage.define(m[exportName] as StreamParser<unknown>)),
    );
}

const js = (opts: { jsx?: boolean; typescript?: boolean } = {}) =>
  import('@codemirror/lang-javascript').then((m) => m.javascript(opts));

// First name is canonical; the rest are aliases matched against the fence tag.
const ROWS: Row[] = [
  ['JavaScript js ecmascript node mjs cjs', () => js()],
  ['TypeScript ts mts cts', () => js({ typescript: true })],
  ['JSX jsx', () => js({ jsx: true })],
  ['TSX tsx', () => js({ jsx: true, typescript: true })],
  ['Python py pyw', () => import('@codemirror/lang-python').then((m) => m.python())],
  ['Rust rs', () => import('@codemirror/lang-rust').then((m) => m.rust())],
  ['Go golang', () => import('@codemirror/lang-go').then((m) => m.go())],
  ['C h', () => import('@codemirror/lang-cpp').then((m) => m.cpp())],
  ['C++ cpp cxx cc hpp', () => import('@codemirror/lang-cpp').then((m) => m.cpp())],
  ['Java', () => import('@codemirror/lang-java').then((m) => m.java())],
  ['PHP', () => import('@codemirror/lang-php').then((m) => m.php())],
  ['HTML htm xhtml', () => import('@codemirror/lang-html').then((m) => m.html())],
  ['CSS', () => import('@codemirror/lang-css').then((m) => m.css())],
  ['JSON json5 jsonc', () => import('@codemirror/lang-json').then((m) => m.json())],
  ['XML svg rss xsd', () => import('@codemirror/lang-xml').then((m) => m.xml())],
  ['SQL', () => import('@codemirror/lang-sql').then((m) => m.sql())],
  ['Markdown md mkd', () => import('@codemirror/lang-markdown').then((m) => m.markdown())],
  ['YAML yml', () => import('@codemirror/lang-yaml').then((m) => m.yaml())],
  ['Vue', () => import('@codemirror/lang-vue').then((m) => m.vue())],
  ['Shell bash sh zsh ksh', legacy(() => import('@codemirror/legacy-modes/mode/shell'), 'shell')],
  ['Ruby rb rake', legacy(() => import('@codemirror/legacy-modes/mode/ruby'), 'ruby')],
  ['Swift', legacy(() => import('@codemirror/legacy-modes/mode/swift'), 'swift')],
  ['Kotlin kt kts', legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'kotlin')],
  ['C# csharp cs', legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'csharp')],
  ['Objective-C objc', legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'objectiveC')],
  ['Scala', legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'scala')],
  ['Dart', legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'dart')],
  [
    'Dockerfile docker',
    legacy(() => import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile'),
  ],
  ['TOML', legacy(() => import('@codemirror/legacy-modes/mode/toml'), 'toml')],
  ['diff patch', legacy(() => import('@codemirror/legacy-modes/mode/diff'), 'diff')],
  ['Lua', legacy(() => import('@codemirror/legacy-modes/mode/lua'), 'lua')],
  [
    'PowerShell ps1',
    legacy(() => import('@codemirror/legacy-modes/mode/powershell'), 'powerShell'),
  ],
  ['Haskell hs', legacy(() => import('@codemirror/legacy-modes/mode/haskell'), 'haskell')],
  ['R', legacy(() => import('@codemirror/legacy-modes/mode/r'), 'r')],
  ['Perl pl pm', legacy(() => import('@codemirror/legacy-modes/mode/perl'), 'perl')],
];

export const codeFenceLanguages: LanguageDescription[] = ROWS.map(([names, load]) => {
  const [name, ...alias] = names.split(' ');
  return LanguageDescription.of({ name, alias, load });
});
