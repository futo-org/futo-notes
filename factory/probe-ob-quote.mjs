import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9876');
const ctx = browser.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('app://obsidian'));
const out = await page.evaluate(async () => {
  await window.__driver.setDoc('intro\n\n> outer\n> > nested line');
  await new Promise(r => setTimeout(r, 80));
  await window.__driver.dispatch([{ type: 'place_cursor', line: 0, ch: 0 }]);
  document.querySelector('.cm-content[data-factory-target="true"]').focus();
  document.activeElement?.blur();
  await new Promise(r => setTimeout(r, 80));
  const root = document.querySelector('.cm-content[data-factory-target="true"]');
  const lines = Array.from(root.querySelectorAll('.cm-line'));
  const nested = lines.find(l => l.textContent.includes('nested line'));
  const result = [];
  const w = document.createTreeWalker(nested, NodeFilter.SHOW_TEXT);
  let n = w.nextNode();
  while (n) {
    const p = n.parentElement;
    const cs = p ? getComputedStyle(p) : null;
    result.push({
      text: JSON.stringify(n.data),
      classes: p ? Array.from(p.classList) : [],
      fontSize: cs?.fontSize,
      color: cs?.color,
      visibility: cs?.visibility,
    });
    n = w.nextNode();
  }
  return { innerText: nested.innerText, textNodes: result };
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
