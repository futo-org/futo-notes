# P1 UI + Link QA Checklist

## Scope
- Validate menu/status bar layout on Android devices.
- Validate clickable links in editor content (markdown links, plain URLs, table links).

## Test Matrix
- Device:
  - Pixel 4a (reported issue device)
  - One Android 13/14+ device for API differences
- Build:
  - Latest debug native build from current branch
- Surfaces:
  - Main note editor
  - Table-rendered markdown widget

## Preconditions
1. Install fresh build.
2. Verify status bar is visible.
3. Open at least one note with mixed markdown content.

## Scenario A: Menu Safe-Area / Status Bar
1. Launch app to note screen.
2. Observe floating hamburger/menu button near top-left.
3. Open/close drawer repeatedly.
4. Rotate device portrait/landscape if supported.

Expected:
- Menu button is not covered by status bar icons/time.
- Menu remains tappable in all tested orientations.
- No clipped hit area.

## Scenario B: Markdown Link Click
1. In note body, enter: `Open [OpenAI](https://openai.com) now`
2. Blur editor (tap title or outside content).
3. Tap visible link text `OpenAI`.

Expected:
- Link opens externally (browser/custom tab).
- App does not freeze/crash.

## Scenario C: Plain URL Auto-Link
1. Enter plain URL text: `Visit https://example.com today`
2. Blur editor.
3. Tap the URL text.

Expected:
- URL appears styled as link.
- Tap opens external browser/custom tab.

## Scenario D: Table Link Behavior
1. Enter table markdown:
   - `| Name | Link |`
   - `|------|------|`
   - `| Test | [Example](https://example.com) |`
   - blank line + trailing text below table
2. Move cursor outside table (or blur editor) so table widget renders.
3. Tap `Example` link inside rendered table.

Expected:
- Link behaves as external link.
- Table wrapper does not swallow the link tap.
- Non-link tap on table still enters edit mode.

## Pass Criteria
- All scenarios pass on Pixel 4a and one additional Android device.
- No status bar overlap in tested layouts.
- All link types open reliably.
