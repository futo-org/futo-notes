// Ad-hoc: run a handful of markdown cases through both variants and print the
// round trip. `node tests/milkdown-census/probe.mjs`
import { chromium } from 'playwright';
import { buildCensusPage } from './build.mjs';

const CASES = {
  'inline br': 'sentence one.<br>sentence two.\n',
  'table cell br': '| a | b |\n| --- | --- |\n| one.<br>two. | x |\n',
  'standalone br': 'para one\n\n<br />\n\npara two\n',
  'soft-broken br': 'line a\n<br />\nline b\n',
  'empty cell': '| a | b |\n| --- | --- |\n|  | x |\n',
  'empty list item': '- a\n-\n- b\n',
  'blockquote br': '> <br />\n',
  'footnote br': 'ref[^4]\n\n[^4]: <br />\n',
  'table in blockquote': '> | a | b |\n> | --- | --- |\n> | one.<br>two. | x |\n',
  'empty link': '## h\n\n[](api-plan.md)\n',
  'empty alt image': '![](pic.png)\n',
  'bullet number': '* 0. item one\n* 1. item two\n',
  kbd: 'press <kbd>K</kbd> now\n',
  comment: '<!-- hi -->\n\ntext\n',
};

const url = await buildCensusPage();
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url);
for (const [name, md] of Object.entries(CASES)) {
  const out = {};
  for (const variant of ['baseline', 'compat']) {
    const r = await page.evaluate(
      ([v, m]) => window.__futoCensus.load(v, m).then((x) => x.markdown),
      [variant, md],
    );
    out[variant] = r;
  }
  console.log(`\n### ${name}`);
  console.log('IN      :', JSON.stringify(md));
  console.log('baseline:', JSON.stringify(out.baseline));
  console.log('compat  :', JSON.stringify(out.compat));
}
await browser.close();
