// Reference extraction for check-agent-docs.mjs: which `just`/`pnpm run`/repo-path tokens in an instruction file count as references.

// Repo paths are only validated when they look path-like: they must contain
// a '/' (bare words like `justfile` or version numbers are not checked), and
// then either end in a file extension or start under one of these roots —
// conservative on purpose to avoid false positives on prose.
export const KNOWN_PATH_PREFIXES = [
  'src/',
  'apps/',
  'crates/',
  'packages/',
  'docs/',
  'tests/',
  'scripts/',
];

// Fenced blocks in these languages are example/illustrative source (mostly
// third-party reference skills such as swift-concurrency-pro), not shell
// commands or repo references — a quoted placeholder filename or an English
// comment containing "just" reads as a broken reference otherwise. None of
// this repo's own instruction files use these fences for real commands.
const CODE_LANGUAGE_DENYLIST = new Set([
  'swift',
  'kotlin',
  'kt',
  'java',
  'objc',
  'objectivec',
  'objective-c',
  'rust',
  'rs',
  'c',
  'cpp',
  'c++',
  'python',
  'py',
]);

const LINE_IGNORE_MARKERS = new Set([
  '<!-- check-agent-docs: ignore-next-line -->',
  '// check-agent-docs: ignore-next-line',
  '# check-agent-docs: ignore-next-line',
]);

const BLOCK_IGNORE_MARKERS = new Set(['<!-- check-agent-docs: ignore-next-block -->']);

// ---------------------------------------------------------------------------
// Reference extraction
// ---------------------------------------------------------------------------

function extractPathCandidate(rawToken) {
  const token = rawToken.replace(/^[(["'[]+/, '').replace(/[)\]"'.,;:!?]+$/, '');
  if (!token.includes('/')) return null;
  if (token.startsWith('/') || token.startsWith('~')) return null; // absolute/home path, not repo-relative
  if (token.includes('$') || token.includes('{') || token.includes('<') || token.includes('>'))
    return null;
  if (token.includes('\\') || token.includes('|') || token.includes('..')) return null; // sed/alternation/git-range/ellipsis, not a path
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) return null; // URL

  const hasKnownPrefix = KNOWN_PATH_PREFIXES.some((prefix) => token.startsWith(prefix));
  const hasExtension = /\.[a-zA-Z0-9]{1,10}$/.test(token.replace(/\/+$/, ''));
  return hasKnownPrefix || hasExtension ? token : null;
}

// Extracts every `just <recipe>`, `pnpm run <script>`, and repo-path
// reference found inside backtick spans (inline `` `like this` ``) or
// fenced ``` code blocks, with the 1-based line number it was found on. A
// line matching the ignore-next-line marker suppresses references on the
// line right after it; the ignore-next-block marker (placed before a
// fence) suppresses the whole block. Fenced blocks tagged with a
// denylisted example-source language (see CODE_LANGUAGE_DENYLIST) are
// skipped entirely — an English comment or placeholder string inside
// example Swift/Kotlin is not a repo reference.
export function extractReferences(text) {
  const refs = [];
  let inFence = false;
  let fenceLanguageDenied = false;
  let fenceBlockIgnored = false;
  let ignoreNextLine = false;
  let ignoreNextBlock = false;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const lineNo = i + 1;
    const trimmed = rawLine.trim();

    if (LINE_IGNORE_MARKERS.has(trimmed)) {
      ignoreNextLine = true;
      continue;
    }
    if (BLOCK_IGNORE_MARKERS.has(trimmed)) {
      ignoreNextBlock = true;
      continue;
    }
    const fence = /^```\s*([a-zA-Z0-9+-]*)/.exec(trimmed);
    if (fence) {
      inFence = !inFence;
      fenceLanguageDenied = inFence && CODE_LANGUAGE_DENYLIST.has(fence[1].toLowerCase());
      fenceBlockIgnored = inFence && ignoreNextBlock;
      ignoreNextLine = false;
      ignoreNextBlock = false;
      continue;
    }

    const shouldIgnore = ignoreNextLine;
    ignoreNextLine = false;
    if (shouldIgnore || (inFence && (fenceLanguageDenied || fenceBlockIgnored))) continue;

    const segments = inFence
      ? [rawLine]
      : [...rawLine.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);

    for (const segment of segments) {
      for (const match of segment.matchAll(/\bjust\s+([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
        refs.push({ line: lineNo, kind: 'just', value: match[1] });
      }
      for (const match of segment.matchAll(/\bpnpm run\s+([a-zA-Z][a-zA-Z0-9_:-]*)/g)) {
        refs.push({ line: lineNo, kind: 'pnpm', value: match[1] });
      }
      // Split on parens/quotes too (not just whitespace) so an embedded
      // reference like `import('/src/x.ts')` isolates cleanly. Braces,
      // brackets, and commas are deliberately NOT delimiters here — they
      // must stay attached so a brace-expansion path list (which contains
      // '{' and is skipped outright, see extractPathCandidate) isn't
      // fragmented into a validated-looking prefix.
      for (const token of segment.split(/[\s()'"`;]+/)) {
        const pathValue = extractPathCandidate(token);
        if (pathValue) refs.push({ line: lineNo, kind: 'path', value: pathValue });
      }
    }
  }

  return refs;
}

// A glob's static prefix directory is the last '/'-delimited segment before
// the first glob character; brace patterns (`{a,b}`) are never extracted in
// the first place (see extractPathCandidate), only `*`/`?` globs reach here.
export function resolvePathCheckTarget(token) {
  const globIndex = token.search(/[*?]/);
  if (globIndex === -1) return { target: token.replace(/\/+$/, ''), isGlob: false };

  const prefix = token.slice(0, globIndex);
  const dir = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix.slice(0, prefix.lastIndexOf('/'));
  return { target: dir || '.', isGlob: true };
}
