# FUTO Notes — native mobile app

The shipping app renders the Rust Linedown engine through `NativeEditorSession`.
iOS uses TextKit 2; Android uses native text views inside Compose. Both debug and
release builds use this renderer. Notes stay Markdown; opening an unchanged note
requires no conversion or rewrite.

Mobile has no web editor host, JavaScript bridge, bundled `editor.html`, or
renderer-selection preference. Desktop continues to use Milkdown.

See [AGENTS.md](AGENTS.md) for builds, tests and device isolation, and the
[engine adoption guide](../../docs/architecture/editor-engine-adoption.md) for
session contracts and shared-engine validation.
