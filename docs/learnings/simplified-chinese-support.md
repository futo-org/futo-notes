# Simplified Chinese support

Date: 2026-08-24
Scope: [GitHub issue #37](https://github.com/futo-org/futo-notes/issues/37), CodeMirror 6, and the current FUTO Notes architecture.

## Conclusion

CodeMirror 6 is not the blocker. It already stores and renders Unicode Chinese text, handles IME composition, wraps unspaced Han text, and includes upstream composition tests using Chinese characters. FUTO Notes also already suspends live-preview decoration rebuilds while an IME composition is active.

There is no Simplified Chinese CodeMirror language package to install. CodeMirror language packages parse programming or markup syntax; UI localization instead uses `EditorState.phrases`. CodeMirror calls this facility rudimentary and does not publish a translation repository, so FUTO must supply the phrases through its shared `zh-Hans` catalog ([official internationalization example](https://codemirror.net/examples/translate/), [`EditorState.phrases` API](https://codemirror.net/docs/ref/#state.EditorState^phrases)).

Basic Chinese editing is therefore a small editor change with a substantial runtime QA requirement. Full Simplified Chinese product support is a broader localization and search project.

## What already works

- The shared editor is Markdown, so Chinese prose needs no language mode. CM6 tracks active composition through `EditorView.composing` and `compositionStarted`, and its upstream browser suite covers composition on empty lines, inside marks and widgets, on Android-style newline insertion, and an IME merge that commits `阿波` ([view API](https://codemirror.net/docs/ref/#view.EditorView.composing), [upstream composition tests](https://code.haverbeke.berlin/codemirror/view/src/branch/main/test/webtest-composition.ts)).
- FUTO's `LiveMarkdownPlugin` does the important app-specific thing: while composition is active it maps existing decorations instead of rebuilding them, then rebuilds after composition. This avoids rewriting the DOM around the composing range, a class of interaction that the CM maintainer says can duplicate Chinese input ([maintainer guidance](https://discuss.codemirror.net/t/replace-chinese-character-with-other-input-someting-strange/8265)).
- FUTO enables `EditorView.lineWrapping`. CM6 implements that with browser wrapping rules including `break-spaces`, `word-break: break-word`, and `overflow-wrap: anywhere`, so long text without spaces can wrap ([upstream theme source](https://code.haverbeke.berlin/codemirror/view/src/branch/main/src/theme.ts), [line-wrapping API](https://codemirror.net/docs/ref/#view.EditorView^lineWrapping)).
- Chinese note bodies, filenames, titles, previews, and wikilink targets pass through Unicode-capable storage and rule paths. The shared editor font stack ends in `system-ui, sans-serif`, so Han glyphs can fall back to the platform font.
- FUTO pins `@codemirror/view` 6.43.6. That includes years of IME/decorations fixes, including the 6.9.3 fix specifically described as repairing composition after widget decorations, especially for Chinese IMEs ([current CM6 view changelog](https://code.haverbeke.berlin/codemirror/view/src/branch/main/CHANGELOG.md)). The current 6.43.9 patches do not claim a Chinese or composition fix, so upgrading is sensible maintenance but not a prerequisite for issue #37.

## Work required

| Area                    |                                             Size | Required outcome                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | -----------------------------------------------: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CM6 language wiring     |                                            Small | Add the required CodeMirror phrases to the shared `zh-Hans` catalog, install them through `EditorState.phrases`, and set the effective document language. Inventory actual `state.phrase(...)` calls in the installed CM packages instead of translating a stale third-party list.                                                                                     |
| Custom editor UI        |                                     Small-medium | Localize FUTO's slash-menu labels and hints, empty state, selection-toolbar labels, tag controls, and toolbar accessibility labels. These are FUTO strings, not CM phrases. The generated toolbar manifest currently projects the same English labels into web, Swift, and Kotlin, so it must project one stable localization path instead.                            |
| Whole-app UI            |                                            Large | The shared catalog and platform formatting foundation now exists, but all three surfaces still contain literal English UI. Install it as reactive shell state, add the language controls, and translate dialogs, errors, accessibility text, onboarding, settings, sync, list, and editor chrome as defined in [`docs/spec/localization.md`](../spec/localization.md). |
| IME verification        |                                   Medium-high QA | Verify real Simplified Chinese IMEs in every shipped WebView. Synthetic `CompositionEvent` tests are useful regressions but cannot prove platform IME behavior.                                                                                                                                                                                                        |
| Search                  | Medium and release-blocking for credible support | Replace or supplement the current default Tantivy tokenizer with a CJK-aware analyzer, use the same analysis for indexing and queries, and version/rebuild the disposable index. Preserve and remeasure existing English BM25, prefix, phrase, fuzzy, title-boost, and recency behavior.                                                                               |
| Fonts/layout            |                    Small QA, possible native fix | Check glyph fallback, weights, line height, clipping, and mixed Latin/Han text. The web editor has a system fallback; Android native UI explicitly uses bundled Latin Barlow files and needs device verification or an explicit CJK fallback family.                                                                                                                   |
| Chinese tags            |                                 Product decision | Tags are deliberately ASCII-only (`[a-z][a-z0-9_-]*`). If Chinese tag names are part of support, this is a canonical Rust + conformance-locked TypeScript rule change, not a CM setting.                                                                                                                                                                               |
| Chinese word boundaries |                             Optional enhancement | Decide whether contiguous Han text selecting/moving as one group is acceptable for the first release. Natural lexical selection is separate from basic input and display.                                                                                                                                                                                              |

## The search gap

FUTO's search schema explicitly selects Tantivy's `default` tokenizer for title, body, tags, and folder. Tantivy 0.26.1 defines that pipeline as `SimpleTokenizer` plus a 40-byte maximum-token filter and lowercasing; the simple tokenizer splits only at non-alphanumeric characters ([Tantivy `SimpleTokenizer` source](https://docs.rs/tantivy/0.26.1/src/tantivy/tokenizer/simple_tokenizer.rs.html), [default tokenizer registry](https://github.com/quickwit-oss/tantivy/blob/0.26.1/src/tokenizer/tokenizer_manager.rs#L53-L77)).

The consequence is inferred directly from those sources: adjacent Han characters remain one token. A user cannot find a Chinese word in the middle of an unpunctuated sentence, and a run of 14 common three-byte Han characters exceeds the default 40-byte limit and is omitted altogether. This makes the editor typeable in Chinese while making ordinary Chinese note retrieval unreliable.

Tantivy supports registered custom tokenizers and points to Jieba and cang-jie as third-party Chinese options; its official n-gram example shows the alternative character n-gram approach ([Tantivy project README](https://github.com/quickwit-oss/tantivy#features), [custom tokenizer example](https://github.com/quickwit-oss/tantivy/blob/main/examples/custom_tokenizer.rs)). Choose between dictionary segmentation and mixed-language n-gram fields using a Chinese relevance corpus. Do not blindly replace the English analyzer: the existing search behavior is measured and specified, and a tokenizer change changes term frequencies, phrases, prefixes, fuzzy matching, and index schema. The existing index is rebuildable from notes, so the rollout should use an explicit new index version rather than trying to reuse old terms.

## CM6 limitations and runtime risk

CM6 categorizes Han characters as word characters and `wordAt` expands across every adjacent character in the same category ([character categorizer](https://code.haverbeke.berlin/codemirror/state/src/branch/main/src/charcategory.ts), [`wordAt` implementation](https://code.haverbeke.berlin/codemirror/state/src/branch/main/src/state.ts#L373-L399)). Thus a desktop double-click, group cursor command, or FUTO's custom off-text double-click can select a whole unspaced Chinese run instead of a lexical word. CM's optional subword commands use `Intl.Segmenter` when available, but the default keymap uses group commands and FUTO supports old Android WebViews where `Intl.Segmenter` may be absent ([subword implementation](https://code.haverbeke.berlin/codemirror/commands/src/branch/main/src/commands.ts#L112-L160)). This should not block baseline support; add guarded locale-aware selection only if Chinese device testing shows it is materially poor.

The embedded browser remains the largest typing risk. In June 2026 the CM maintainer reproduced a Windows Chrome 149 Chinese punctuation failure in a minimal `contenteditable`, proving it was a Chromium bug rather than a CM extension bug; Edge WebView2 users also reported it ([CodeMirror report](https://discuss.codemirror.net/t/chinese-ime-punctuation-input-loses-every-other-keypress-requires-2-presses-per-character/9741#post_7)). Chromium's M149 and M150 merge issues for the fix are marked fixed ([M149 merge](https://issues.chromium.org/issues/523453248), [M150 merge](https://issues.chromium.org/issues/523453997)). FUTO should still test the actual WebView2 runtime it ships against and record the engine version with failures.

## Acceptance matrix

Use real IMEs, not only dispatched DOM events:

- Windows desktop / WebView2: Microsoft Pinyin; include a second IME if available.
- macOS desktop and iOS / WKWebView: Simplified Pinyin.
- Android / System WebView: Gboard Chinese (Pinyin) and one widely used Chinese IME if practical.
- Linux / WebKitGTK: Fcitx5 Pinyin.

On each, verify candidate selection by Space and Enter; `，。！？；：“”`; rapid composition; newline and backspace; replacing a selection; undo/redo; long wrapped paragraphs; note save/reopen; and input beside hidden Markdown markers, wikilinks, code, tables, images, and slash-menu widgets. Also verify title entry, search, Chinese filenames/wikilinks, mixed Latin/Han text, screen-reader labels, and native toolbar/localized chrome.

## Recommended issue split

1. Chinese IME/editor acceptance and `zh-Hans` editor strings.
2. Cross-platform `zh-Hans` UI localization infrastructure and translation.
3. CJK-aware full-text indexing with an index migration and ranking corpus.
4. Optional Chinese tags and locale-aware word selection after the baseline is device-tested.

That split keeps CM6 support small and testable while making the two real product gaps—localization and retrieval—explicit.
