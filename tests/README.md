# Markdown Rendering Test Harness

This test harness verifies that the CodeMirror markdown rendering matches expectations.

## Files

- `gfm-test-note.md` - Comprehensive GFM (GitHub Flavored Markdown) test file
- `gfm-test-note.html` - Expected HTML output from Obsidian (source of truth for comparison)
- `gfm-test-note.snapshot.json` - Snapshot of CodeMirror's rendered DOM structure
- `markdown-render-test.js` - Test harness script

## How It Works

The test harness:

1. Spins up a headless browser (Puppeteer)
2. Loads the CodeMirror bundle from `lib/codemirror-bundle-string.ts`
3. Renders the test markdown file
4. Captures the DOM structure with all CSS classes that CodeMirror applies
5. Saves a snapshot for comparison

The snapshot captures:
- Line-by-line structure
- CSS classes applied (`.cm-md-h1`, `.cm-md-strong`, `.cm-md-emphasis`, etc.)
- Text content and widget elements

## Usage

### Generate/Update Snapshot

```bash
npm run test:markdown
```

This generates `gfm-test-note.snapshot.json` which captures the current rendering state.

### Verify Rendering

```bash
npm run test:markdown:verify
```

This compares the current rendering against the saved snapshot. If they don't match, it:
- Exits with code 1
- Saves a diff file to `gfm-test-note.snapshot.diff.json`

## Workflow

### Making Changes to Markdown Rendering

1. Make changes to CodeMirror config (e.g., `lib/editor-setup.js`, `lib/PreloadedEditorContext.tsx`)
2. Rebuild the CodeMirror bundle: `npm run bundle:codemirror`
3. Run the test: `npm run test:markdown:verify`
4. If the rendering changed:
   - Inspect the diff file to see what changed
   - If the changes are intentional, update the snapshot: `npm run test:markdown`
   - If not, fix the issue and repeat

### Fixing Rendering Issues

When you want to fix a rendering issue (e.g., "make blockquotes render correctly"):

1. Run the test to see current state: `npm run test:markdown:verify`
2. Make changes to the editor setup
3. Rebuild: `npm run bundle:codemirror`
4. Re-run test: `npm run test:markdown:verify`
5. Repeat until test passes or rendering matches expectations
6. Update snapshot if needed: `npm run test:markdown`

## What the Snapshot Captures

The snapshot is a JSON array where each element represents one line in the editor. Each line contains:

```json
{
  "line": 1,
  "elements": [
    {
      "type": "text",
      "content": "GFM Syntax Test Note",
      "depth": 2
    },
    {
      "type": "element",
      "tag": "span",
      "classes": ["cm-md-h1"],
      "depth": 1
    }
  ]
}
```

This allows us to verify:
- Which CSS classes are applied to which text
- Whether markdown syntax characters are hidden/replaced correctly
- Whether widgets (bullets, checkboxes, HRs) are rendered

## Limitations

This tests the **CodeMirror rendering** (syntax highlighting and decorations), not:
- The final HTML output (CodeMirror doesn't generate HTML from markdown)
- Visual appearance (CSS styles are defined but not tested visually)
- Interactive behavior (checkboxes, links, etc.)

For comparing against the expected HTML output (`gfm-test-note.html`), you would need a separate test that uses an actual markdown-to-HTML renderer.

## Notes

- The test uses your actual CodeMirror setup from the app
- Puppeteer downloads a compatible Chrome binary automatically on first install
- The test runs in headless mode (no visible browser window)
- Each test run takes ~2-3 seconds
