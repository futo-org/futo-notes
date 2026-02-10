# P2 Header + Formatting QA Checklist

## Scope
- Validate title `Enter` behavior (jump from header to body editor).
- Validate bold/italic/strikethrough close behavior when trailing spaces are typed before closing markers.

## Preconditions
1. Install latest build (web or native).
2. Open or create a note.

## Scenario A: Title Enter to Body
1. Tap title input.
2. Type any title text.
3. Press `Enter`.
4. Type body text immediately.

Expected:
- Focus moves to markdown editor body.
- Body text is inserted in note content, not title.

## Scenario B: Bold With Trailing Space
1. Tap bold toolbar button.
2. Type: `boldword ` (note trailing space).
3. Tap bold toolbar button again to close.
4. Type: `tail`.
5. Blur editor.

Expected:
- `boldword` renders as bold.
- `tail` is plain text outside bold.
- No raw `**` markers visible in rendered mode.

## Scenario C: Italic With Trailing Space
1. Tap italic toolbar button.
2. Type: `italicword `.
3. Tap italic toolbar button again.
4. Type: `tail`.
5. Blur editor.

Expected:
- `italicword` renders italic.
- `tail` is outside italic formatting.

## Scenario D: Strikethrough With Trailing Space
1. Tap strikethrough toolbar button.
2. Type: `strikeword `.
3. Tap strikethrough toolbar button again.
4. Type: `tail`.
5. Blur editor.

Expected:
- `strikeword` renders with strike.
- `tail` is outside strikethrough.

## Pass Criteria
- All scenarios pass without malformed formatting.
- No crashes or stuck cursor states during toolbar toggles.
