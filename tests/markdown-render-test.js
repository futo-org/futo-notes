#!/usr/bin/env node
/**
 * Test harness for verifying CodeMirror markdown rendering
 *
 * This script:
 * 1. Spins up a headless browser (Puppeteer)
 * 2. Loads CodeMirror with the test markdown file
 * 3. Extracts the rendered DOM structure with all CSS classes
 * 4. Saves a snapshot for comparison
 *
 * Usage:
 *   node tests/markdown-render-test.js                  # Generate snapshot
 *   node tests/markdown-render-test.js --verify         # Verify against snapshot
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const TEST_MD_FILE = path.join(__dirname, 'gfm-test-note.md');
const SNAPSHOT_FILE = path.join(__dirname, 'gfm-test-note.snapshot.json');

/**
 * Gets the CodeMirror HTML from the actual component
 */
function getCodeMirrorHTML() {
  // Parse the TypeScript bundle file to extract the strings
  const bundleFilePath = path.join(__dirname, '../lib/codemirror-bundle-string.ts');
  const bundleContent = fs.readFileSync(bundleFilePath, 'utf-8');

  // Extract the exported strings using regex
  const cmMatch = bundleContent.match(/export const CODEMIRROR_BUNDLE = (.+);/);
  const editorMatch = bundleContent.match(/export const EDITOR_SETUP = (.+);/);
  const fontsMatch = bundleContent.match(/export const FONTS_CSS = (.+);/);

  if (!cmMatch || !editorMatch || !fontsMatch) {
    throw new Error('Failed to parse bundle strings from TypeScript file');
  }

  const CODEMIRROR_BUNDLE = JSON.parse(cmMatch[1]);
  const EDITOR_SETUP = JSON.parse(editorMatch[1]);
  const FONTS_CSS = JSON.parse(fontsMatch[1]);

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    ${FONTS_CSS}
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: #fff;
      font-family: 'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    #editor {
      width: 100%;
      height: 100%;
    }
    .cm-editor {
      height: 100%;
      font-size: 16px;
    }
    .cm-editor .cm-scroller {
      padding: 16px;
      line-height: 1.5;
    }
    .cm-editor .cm-content {
      caret-color: #007AFF;
    }
    .cm-editor.cm-focused {
      outline: none;
    }
    .cm-editor .cm-gutters {
      display: none;
    }
    .cm-editor .cm-activeLine {
      background: transparent;
    }
    .cm-editor .cm-activeLineGutter {
      background: transparent;
    }

    /* Markdown styles */
    .cm-md-h1 { font-size: 1.8em; line-height: 1.3; }
    .cm-md-h2 { font-size: 1.5em; line-height: 1.3; }
    .cm-md-h3 { font-size: 1.25em; line-height: 1.4; }
    .cm-md-h4 { font-size: 1.1em; line-height: 1.4; }
    .cm-md-h5 { font-size: 1em; line-height: 1.5; }
    .cm-md-h6 { font-size: 0.9em; line-height: 1.5; color: #666; }
    .cm-md-emphasis { font-style: italic; }
    .cm-md-strong { font-weight: 700; }
    .cm-md-strikethrough { text-decoration: line-through; color: #888; }
    .cm-md-code {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      background: #f4f4f4;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 0.9em;
    }
    .cm-md-codeblock {
      font-family: 'IBM Plex Mono', ui-monospace, monospace;
      background: #f4f4f4;
      font-size: 0.9em;
    }
    .cm-md-link { color: #007AFF; text-decoration: underline; }
    .cm-md-task-checked { text-decoration: line-through; color: #888; }
    .cm-md-blockquote {
      border-left: 3px solid #ddd;
      padding-left: 12px;
      color: #666;
      font-style: italic;
    }
    .cm-md-hr {
      height: 2px;
      background: #ddd;
      margin: 8px 0;
    }
  </style>
</head>
<body>
  <div id="editor"></div>
  <script>
    // Mock ReactNativeWebView for standalone testing
    window.ReactNativeWebView = {
      postMessage: function(msg) {
        // In test mode, we just log these
        const data = JSON.parse(msg);
        if (data.type === 'ready') {
          window.__editorReady = true;
        }
      }
    };
  </script>
  <script>${CODEMIRROR_BUNDLE}</script>
  <script>
    // Monkey-patch EditorView constructor to capture the view instance
    (function() {
      const OriginalEditorView = window.CM.EditorView;
      window.CM.EditorView = function(...args) {
        const instance = new OriginalEditorView(...args);
        window.__editorView = instance;
        return instance;
      };
      // Copy static properties
      Object.setPrototypeOf(window.CM.EditorView, OriginalEditorView);
      Object.assign(window.CM.EditorView, OriginalEditorView);
    })();
  </script>
  <script>${EDITOR_SETUP}</script>
  <script>
    // Helper to get editor content with decorations
    window.getEditorSnapshot = function() {
      const view = window.__editorView;
      if (!view) {
        console.error('Test view not captured');
        return null;
      }

      const content = view.contentDOM;
      const lines = Array.from(content.querySelectorAll('.cm-line'));

      return lines.map((line, idx) => {
        // Get all elements in this line
        const elements = [];

        function traverse(node, depth = 0) {
          if (node.nodeType === Node.TEXT_NODE) {
            const text = node.textContent;
            if (text) {
              elements.push({
                type: 'text',
                content: text,
                depth
              });
            }
          } else if (node.nodeType === Node.ELEMENT_NODE) {
            const classes = Array.from(node.classList).filter(c => c.startsWith('cm-md-') || c === 'cm-widgetBuffer');
            const tagName = node.tagName.toLowerCase();

            if (classes.length > 0 || tagName !== 'span') {
              elements.push({
                type: 'element',
                tag: tagName,
                classes: classes,
                depth
              });
            }

            // Traverse children
            for (const child of node.childNodes) {
              traverse(child, depth + 1);
            }
          }
        }

        traverse(line);

        return {
          line: idx + 1,
          elements
        };
      });
    };
  </script>
</body>
</html>
  `;
}

/**
 * Extracts the rendered structure from CodeMirror
 */
async function extractRenderedStructure(page, markdown) {
  // Wait for editor to be ready
  await page.waitForFunction(() => window.__editorReady === true, { timeout: 5000 });

  // Set the content
  await page.evaluate((content) => {
    window.handleRNMessage(JSON.stringify({
      type: 'init',
      content: content
    }));
  }, markdown);

  // Wait a bit longer for decorations to apply and view to be exposed
  await new Promise(resolve => setTimeout(resolve, 1000));

  // Extract the snapshot
  const snapshot = await page.evaluate(() => {
    return window.getEditorSnapshot();
  });

  return snapshot;
}

/**
 * Main test runner
 */
async function main() {
  const isVerify = process.argv.includes('--verify');

  console.log('Reading test markdown file...');
  const markdown = fs.readFileSync(TEST_MD_FILE, 'utf-8');

  console.log('Launching headless browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    // Set a very large viewport to ensure all content is rendered
    await page.setViewport({ width: 1920, height: 20000 });

    // Enable console logging from the page
    page.on('console', msg => {
      const text = msg.text();
      if (msg.type() === 'error') {
        console.error('Browser console error:', text);
      } else if (text.includes('Found node type')) {
        console.log('Debug:', text);
      }
    });

    console.log('Loading CodeMirror...');
    const html = getCodeMirrorHTML();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    console.log('Extracting rendered structure...');
    const snapshot = await extractRenderedStructure(page, markdown);

    if (isVerify) {
      // Verify mode: compare with existing snapshot
      if (!fs.existsSync(SNAPSHOT_FILE)) {
        console.error('❌ No snapshot file found. Run without --verify to generate one.');
        process.exit(1);
      }

      const expectedSnapshot = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
      const currentSnapshot = JSON.stringify(snapshot, null, 2);
      const expectedSnapshotStr = JSON.stringify(expectedSnapshot, null, 2);

      if (currentSnapshot === expectedSnapshotStr) {
        console.log('✅ Rendering matches snapshot!');
        process.exit(0);
      } else {
        console.error('❌ Rendering does not match snapshot!');
        console.error('Run without --verify to update the snapshot.');

        // Save diff for inspection
        const diffFile = path.join(__dirname, 'gfm-test-note.snapshot.diff.json');
        fs.writeFileSync(diffFile, JSON.stringify({
          expected: expectedSnapshot,
          actual: snapshot
        }, null, 2));
        console.error(`Diff saved to: ${diffFile}`);

        process.exit(1);
      }
    } else {
      // Generate mode: save snapshot
      if (!snapshot) {
        console.error('❌ Failed to extract snapshot - snapshot is null');
        console.error('Check the browser console output above for errors');
        process.exit(1);
      }

      fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2));
      console.log(`✅ Snapshot saved to: ${SNAPSHOT_FILE}`);
      console.log(`   Lines captured: ${snapshot.length}`);
      console.log('');
      console.log('To verify rendering in the future, run:');
      console.log('  node tests/markdown-render-test.js --verify');
    }

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
