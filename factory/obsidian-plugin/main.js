// FUTO Notes Factory Driver — Obsidian plugin.
//
// Exposes the same protocol surface as the stonefruit driver, but over
// localhost HTTP since the judge process is external to Obsidian. Runs
// only on desktop (Node http module is available in Electron).
//
// The shape returned by /state mirrors factory/driver/protocol.ts.
// classToKind logic is duplicated here in JS; if the canonical mapping
// in protocol.ts changes, update this too.

'use strict';

const obsidian = require('obsidian');
const http = require('http');

const PORT = parseInt(process.env.FACTORY_DRIVER_PORT || '27124', 10);

class FactoryDriverPlugin extends obsidian.Plugin {
  async onload() {
    this.server = null;
    this.startServer();
    console.log(`[factory-driver] listening on http://127.0.0.1:${PORT}`);
  }

  onunload() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  startServer() {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('[factory-driver] error', err);
        try {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: String(err && err.stack || err) }));
        } catch (_) { /* ignore */ }
      });
    });
    this.server.listen(PORT, '127.0.0.1');
  }

  async handle(req, res) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

    const url = req.url || '/';
    if (req.method === 'GET' && url === '/identify') {
      return this.json(res, { name: 'obsidian', version: this.app.appVersion || 'unknown' });
    }
    if (req.method === 'GET' && url === '/state') {
      return this.json(res, await this.captureState());
    }
    if (req.method === 'POST' && url === '/set-doc') {
      const body = await this.readJson(req);
      await this.setDoc(body.markdown ?? '');
      return this.json(res, { ok: true });
    }
    if (req.method === 'POST' && url === '/dispatch') {
      const body = await this.readJson(req);
      const events = Array.isArray(body.events) ? body.events : [];
      for (const ev of events) await this.applyEvent(ev);
      return this.json(res, { ok: true });
    }

    res.statusCode = 404;
    res.end('not found');
  }

  json(res, obj) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
  }

  async readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
        catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  // ----- driver actions -----

  async ensureScratchView() {
    // Open a scratch markdown file the judge owns. Recreate each set-doc
    // so we never leak state between scenarios.
    const path = '__factory_scratch.md';
    let file = this.app.vault.getAbstractFileByPath(path);
    if (!file) {
      file = await this.app.vault.create(path, '');
    }
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true, state: { mode: 'source' } });
    // Ensure live preview, not source mode. Obsidian distinguishes these
    // via state.source — false means live preview.
    await leaf.setViewState({
      type: 'markdown',
      state: { file: path, mode: 'source', source: false },
    });
    return leaf;
  }

  getActiveCM() {
    const view = this.app.workspace.getActiveViewOfType(obsidian.MarkdownView);
    if (!view) throw new Error('no active markdown view');
    const cm = view.editor && view.editor.cm;
    if (!cm) throw new Error('CM EditorView not exposed on Editor');
    return cm;
  }

  async setDoc(markdown) {
    const leaf = await this.ensureScratchView();
    const view = leaf.view;
    const editor = view.editor;
    editor.setValue(markdown);
    await this.tick();
  }

  async applyEvent(ev) {
    const cm = this.getActiveCM();
    switch (ev.type) {
      case 'set_doc':
        await this.setDoc(ev.markdown ?? '');
        break;
      case 'place_cursor': {
        const pos = this.lineChToPos(cm, ev.line, ev.ch);
        cm.dispatch({ selection: { anchor: pos, head: pos } });
        cm.focus();
        break;
      }
      case 'type': {
        const sel = cm.state.selection.main;
        cm.dispatch({
          changes: { from: sel.from, to: sel.to, insert: ev.text || '' },
          selection: { anchor: sel.from + (ev.text || '').length, head: sel.from + (ev.text || '').length },
        });
        break;
      }
      case 'key': {
        const ev2 = new KeyboardEvent('keydown', { key: ev.key, bubbles: true, cancelable: true });
        cm.contentDOM.dispatchEvent(ev2);
        break;
      }
      case 'blur': cm.contentDOM.blur(); break;
      case 'focus': cm.focus(); break;
      default: break;
    }
    await this.tick();
  }

  async tick() {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
  }

  lineChToPos(cm, line, ch) {
    const doc = cm.state.doc;
    const target = Math.min(Math.max(line, 0), doc.lines - 1);
    const lineInfo = doc.line(target + 1);
    return lineInfo.from + Math.min(Math.max(ch, 0), lineInfo.length);
  }

  posToPosition(cm, pos) {
    const line = cm.state.doc.lineAt(pos);
    return { line: line.number - 1, ch: pos - line.from, pos };
  }

  // ----- state capture -----

  async captureState() {
    const cm = this.getActiveCM();
    const sel = cm.state.selection.main;
    const cursor = this.posToPosition(cm, sel.head);
    const anchor = this.posToPosition(cm, sel.anchor);
    return {
      doc: cm.state.doc.toString(),
      cursor,
      selection: { head: cursor, anchor },
      decorations: this.extractDecorations(cm),
      visibleText: cm.contentDOM.innerText,
    };
  }

  extractDecorations(cm) {
    const out = [];
    const root = cm.contentDOM;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.nextNode();
    while (node) {
      if (node.classList.length > 0 && !node.classList.contains('cm-line')) {
        const classes = Array.from(node.classList);
        const kind = classToKind(classes);
        const interesting = kind !== 'unknown' || classes.some((c) =>
          /^cm-(md-|hashtag|formatting|strong|em|strikethrough|link|url|inline-code|header|quote|hmd|cm-formatting)/.test(c)
        );
        if (interesting) {
          try {
            const fromPos = cm.posAtDOM(node, 0);
            const widget = isWidgetEl(node);
            let toPos;
            if (widget) {
              const next = node.nextSibling;
              toPos = next ? cm.posAtDOM(next, 0) : fromPos + 1;
            } else {
              toPos = fromPos + (node.textContent || '').length;
            }
            out.push({
              from: this.posToPosition(cm, fromPos),
              to: this.posToPosition(cm, Math.max(toPos, fromPos)),
              kind,
              replaced: widget,
              classes,
              text: node.textContent || '',
            });
          } catch (_) { /* detached node */ }
        }
      }
      node = walker.nextNode();
    }
    return out;
  }
}

function isWidgetEl(el) {
  if (el.classList.contains('cm-widgetBuffer')) return false;
  return (
    el.classList.contains('cm-md-hr-widget') ||
    el.classList.contains('cm-md-image-wrapper') ||
    el.classList.contains('cm-md-image-widget') ||
    el.classList.contains('cm-md-table-wrapper') ||
    el.classList.contains('cm-md-table-rendered') ||
    el.classList.contains('cm-md-task-checkbox-wrapper') ||
    // Obsidian's embedded image / internal-embed widgets
    el.classList.contains('internal-embed') ||
    el.classList.contains('cm-embed-block')
  );
}

// Mirror of factory/driver/semanticKind.ts. Kept inline because Obsidian
// loads main.js as a single bundle with no module resolution back to
// the host repo.
function classToKind(classes) {
  const set = new Set(classes);

  if (set.has('cm-md-quote-marker-hidden')) return 'quote-marker';
  if (set.has('cm-md-inline-marker')) return 'italic-marker';

  for (let n = 1; n <= 6; n++) {
    if (set.has(`cm-md-h${n}-marker`)) return 'heading-marker';
  }
  for (let n = 1; n <= 6; n++) {
    if (set.has(`cm-md-h${n}`) || set.has(`cm-header-${n}`)) {
      return `heading-text-${n}`;
    }
  }
  if (set.has('cm-md-h') || set.has('cm-header')) return 'heading-text-1';

  if (set.has('cm-md-strong')) return 'bold-text';
  if (set.has('cm-md-emphasis')) return 'italic-text';
  if (set.has('cm-md-strikethrough')) return 'strikethrough-text';
  if (set.has('cm-strong')) return 'bold-text';
  if (set.has('cm-em')) return 'italic-text';
  if (set.has('cm-strikethrough')) return 'strikethrough-text';

  if (
    set.has('cm-md-code-block') || set.has('cm-md-code-block-first') ||
    set.has('cm-md-code-block-middle') || set.has('cm-md-code-block-last') ||
    set.has('cm-md-code-block-single')
  ) return 'code-block';
  if (set.has('cm-md-code') || set.has('cm-inline-code')) return 'code-inline';

  if (set.has('cm-md-autolink')) return 'autolink';
  if (set.has('cm-md-link') || set.has('cm-link')) return 'link-text';
  if (set.has('cm-url')) return 'link-url';

  if (set.has('cm-md-task-checkbox') || set.has('cm-md-task-checkbox-wrapper')) return 'list-task-checkbox';
  if (set.has('cm-md-task')) return 'list-task-text';
  if (set.has('cm-md-bullet') || set.has('cm-md-number')) return 'list-marker';
  if (set.has('cm-md-ul-item') || set.has('cm-md-ol-item') || set.has('cm-md-list-line')) return 'unknown';

  if (set.has('cm-md-quote-marker')) return 'quote-marker';
  if (
    set.has('cm-md-quote') ||
    set.has('cm-md-quote-first') || set.has('cm-md-quote-middle') ||
    set.has('cm-md-quote-last')  || set.has('cm-md-quote-single')
  ) return 'quote-text';
  if (set.has('cm-quote')) return 'quote-text';

  if (set.has('cm-md-hr-widget')) return 'hr-widget';
  if (set.has('cm-md-image-widget') || set.has('cm-md-image-wrapper')) return 'image-widget';
  if (set.has('cm-md-table-rendered') || set.has('cm-md-table-wrapper')) return 'table-widget';

  if (set.has('cm-md-wikilink')) return 'wikilink';
  if (set.has('cm-md-tag')) return 'tag';
  if (set.has('cm-hashtag') || set.has('cm-hashtag-end') || set.has('cm-hashtag-begin')) return 'tag';

  if (set.has('cm-formatting')) {
    if (set.has('cm-formatting-strong')) return 'bold-marker';
    if (set.has('cm-formatting-em')) return 'italic-marker';
    if (set.has('cm-formatting-strikethrough')) return 'strikethrough-marker';
    if (set.has('cm-formatting-header')) return 'heading-marker';
    if (set.has('cm-formatting-link')) return 'link-marker';
    if (set.has('cm-formatting-quote')) return 'quote-marker';
    if (set.has('cm-formatting-code')) return 'code-fence-marker';
    if (set.has('cm-formatting-list')) return 'list-marker';
  }

  return 'unknown';
}

module.exports = FactoryDriverPlugin;
