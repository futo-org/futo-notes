// L6b generative fuzz: random documents built from a vocabulary of
// block-structure-sensitive lines, compared whole vs finest-chunked through the
// shipped bundle's `?census` door. Synthetic text only. Not in CI.
//
// Usage: node tests/editor-fuzz/progressive-open/chunk-fuzz.mjs --seed 1 --cases 2000 --out <dir>
// Writes <dir>/divergent-<seed>.jsonl (minimized cases) and <dir>/summary-<seed>.json.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { openCensusPage, compare } from './census-page.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, v, i, a) => (v.startsWith('--') ? [...acc, [v.slice(2), a[i + 1]]] : acc), []),
);
const seed = Number(args.seed ?? 1);
const cases = Number(args.cases ?? 1000);
const out = args.out ?? 'build/l6b-fuzz';
mkdirSync(out, { recursive: true });

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(seed);
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

// Vocabulary. Exotic characters are ESCAPES (AGENTS.md M27).
const V = [
  '',
  '',
  '',
  '',
  ' ',
  '\t',
  'para text',
  'more words here',
  'x',
  'a | b',
  '| a | b |',
  '|---|---|',
  '--- | ---',
  '- | -',
  ':-: | :-:',
  '# h',
  '## h2',
  '#',
  ' # h',
  '#tag word',
  '```',
  '```js',
  ' ```',
  '  ```',
  '   ```',
  '````',
  '~~~',
  ' ~~~',
  '    code',
  '\tcode',
  '      deep',
  '- a',
  '* a',
  '+ a',
  '1. a',
  '2. a',
  '1) a',
  '10. a',
  '- ',
  '-',
  '*',
  '1.',
  '  - a',
  '   - b',
  '    - c',
  '  cont',
  '   cont',
  '- [ ] task',
  '- [x] done',
  '> q',
  '>',
  '> > qq',
  ' > q',
  '>- a',
  '> # h',
  '---',
  '***',
  '___',
  '- - -',
  '* * *',
  '===',
  '==',
  '<div>',
  '</div>',
  '<!--',
  '-->',
  '<!-- c -->',
  '<pre>',
  '</pre>',
  '<?x',
  '?>',
  '<!DOCTYPE x',
  '<![CDATA[',
  ']]>',
  '<span>',
  '</span>',
  '<br>',
  '<br />',
  '<details>',
  '<summary>s</summary>',
  '[[wiki]]',
  '![[img.png]]',
  '![alt](i.png)',
  '[l](u)',
  '[](u)',
  'end\\',
  'two  ',
  '$$',
  'a $x$ b',
  '[x]',
  '\\# not',
  '&nbsp;',
  'x\u00a0y',
  '\u00a0',
  'word\u200bword',
  '\u202eltr',
  'cafe\u0301',
];

// --vocab 2 adds more exotic whitespace and document-scoped constructs.
const V2 = [
  String.fromCharCode(0x3000),
  String.fromCharCode(0x2028),
  String.fromCharCode(0x0c),
  String.fromCharCode(0x0b),
  'a' + String.fromCharCode(0x0d) + '# h',
  String.fromCharCode(0xfeff) + '# h',
  String.fromCharCode(0xfeff) + 'text',
  '- [a]: /u',
  '> [a]: /u',
  '  [a]: /u',
  '[t][a]',
  '[a]',
  'x[^1]',
  '- [^1]: n',
  '<!-->',
  '<!--->',
  '<?>',
  '1. [ ] t',
  '\t- a',
  '  1. a',
  '>> q',
  '> - a',
  '>     code',
  '- > q',
  '* ```',
  '- ~~~',
  '  > q',
  '<table>',
  '<td>',
  '</table>',
  '<!-- a',
  'b -->',
  '`code`',
  '``',
  '***bold***',
  '__u__',
  '<https://x.y>',
  // FB-8 repair: HTML opened inside a container, and an autolink that must NOT stop the scan.
  '- <!--',
  '- <pre>',
  '> <pre>',
  '1. <pre>',
  '* <script>',
  '  - <pre>',
  '> <!--',
  '- <https://x.y>',
  '[a',
  '<span>]: /u',
];
if (String(args.vocab ?? '1') === '2') V.push(...V2, ...V2);

function genDoc() {
  const n = 8 + Math.floor(rnd() * 40);
  const lines = [];
  for (let i = 0; i < n; i += 1) lines.push(pick(V));
  // FB-8 repair: half the time with `---` front matter whose interior is fuzzed too
  // (a fence-looking line in YAML opened a phantom fence in the scanner).
  if (rnd() < 0.15) {
    const fm = [];
    for (let i = Math.floor(rnd() * 4); i > 0; i -= 1) fm.push(pick(V));
    lines.unshift('---', ...fm, '---');
  }
  let md = lines.join('\n') + (rnd() < 0.8 ? '\n' : '');
  if (rnd() < 0.08) md = md.replace(/\n/g, '\r\n');
  // RC-07 (FB-4b): a lone leading `---` (front matter with no closer) misparses on the WHOLE
  // path, so it would mask every other class. Set NO_LEADING_RULE=1 to prefix such docs.
  // Real front matter (`---` ... `---`) is kept.
  if (
    process.env.NO_LEADING_RULE &&
    /^---\r?\n/.test(md) &&
    !/^---\r?\n[^]*?\r?\n---[ \t]*(\r?\n|$)/.test(md)
  ) {
    md = 'x\n' + md;
  }
  return md;
}

const diverges = (r) => r.whole !== r.chunked;

async function minimize(page, md) {
  const eol = md.includes('\r\n') ? '\r\n' : '\n';
  let lines = md.split(eol);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < lines.length; i += 1) {
      const trial = lines.slice(0, i).concat(lines.slice(i + 1));
      const r = await compare(page, trial.join(eol));
      if (diverges(r) && !r.aborted) {
        lines = trial;
        changed = true;
        i -= 1;
      }
    }
  }
  return lines.join(eol);
}

const { browser, page, errors } = await openCensusPage();
const summary = {
  seed,
  cases,
  chunked: 0,
  aborted: 0,
  divergent: 0,
  docOnly: 0,
  checkErrors: 0,
  nullSerialization: 0,
  pageerrors: 0,
  start: new Date().toISOString(),
};
const seen = new Set();
const divFile = path.join(out, `divergent-${seed}.jsonl`);
for (let k = 0; k < cases; k += 1) {
  const md = genDoc();
  const r = await compare(page, md);
  if (r.wasChunked) summary.chunked += 1;
  if (r.whole === null || r.chunked === null) {
    summary.nullSerialization += 1;
    appendFileSync(
      path.join(out, `null-${seed}.jsonl`),
      JSON.stringify({ k, md, whole: r.whole, chunked: r.chunked }) + '\n',
    );
  }
  if (r.aborted) {
    summary.aborted += 1;
    continue;
  }
  if (r.checkError) summary.checkErrors += 1;
  if (!diverges(r)) {
    if (!r.docEqual) summary.docOnly += 1;
    continue;
  }
  summary.divergent += 1;
  const min = await minimize(page, md);
  if (seen.has(min)) continue;
  seen.add(min);
  const m = await compare(page, min);
  appendFileSync(
    divFile,
    JSON.stringify({ k, minimized: min, whole: m.whole, chunked: m.chunked }) + '\n',
  );
}
summary.pageerrors = errors.length;
summary.pageerrorSamples = errors.slice(0, 5);
summary.unique = seen.size;
summary.end = new Date().toISOString();
writeFileSync(path.join(out, `summary-${seed}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
await browser.close();
