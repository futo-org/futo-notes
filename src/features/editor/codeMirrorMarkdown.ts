import type { Extension } from '@codemirror/state';
import { syntaxHighlighting, type LanguageSupport } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { classHighlighter, type Highlighter } from '@lezer/highlight';

const MARKDOWN_PROSE_TOKEN_CLASSES = new Set([
  'tok-emphasis',
  'tok-strong',
  'tok-heading',
  'tok-link',
]);

const codeBlockHighlighter: Highlighter = {
  style(tags) {
    const classes = classHighlighter.style(tags);
    if (!classes) return null;

    const filtered = classes
      .split(' ')
      .filter((className) => !MARKDOWN_PROSE_TOKEN_CLASSES.has(className));
    return filtered.length ? filtered.join(' ') : null;
  },
};

export function createMarkdownLanguageSupport(): LanguageSupport {
  return markdown({
    base: markdownLanguage,
    codeLanguages: languages,
  });
}

export function markdownEditorLanguageExtensions(): Extension[] {
  return [createMarkdownLanguageSupport(), syntaxHighlighting(codeBlockHighlighter)];
}
