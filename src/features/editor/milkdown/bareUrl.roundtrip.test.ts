/*
 * `bareUrlLinkHandler` (packages/editor/src/milkdown-compat/bareUrl.ts) writes
 * a link bare only when the bare spelling reads back as the same link. This
 * drives a REAL `Editor` with the serializer editorPlugins.ts installs —
 * the narrowed `text` handler and the bare-URL `link` handler — because the
 * question is what the editor's own parser makes of the editor's own output,
 * in context: the characters after a URL include escapes and mark closers the
 * link handler does not write itself.
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  remarkCtx,
  remarkStringifyOptionsCtx,
  rootCtx,
} from '@milkdown/kit/core';
import type { Node as ProseNode } from '@milkdown/kit/prose/model';
import { getMarkdown } from '@milkdown/kit/utils';

import {
  bareUrlLinkHandler,
  commonmarkWithCompat,
  gfmWithCompat,
  withNarrowedEscapes,
} from '@futo-notes/editor/milkdown-compat';
import { withoutLeakedCtxTimers } from './__fixtures__/noLeakedCtxTimers';

interface Opened {
  saved: string;
  links: { text: string; href: string }[];
}

function linksOf(doc: ProseNode): Opened['links'] {
  const links: Opened['links'] = [];
  doc.descendants((node) => {
    const mark = node.marks.find((m) => m.type.name === 'link');
    if (node.isText && mark) links.push({ text: node.text ?? '', href: String(mark.attrs.href) });
  });
  return links;
}

/** Open `markdown` in the editor, save it, and report the links it showed. */
async function open(markdown: string): Promise<Opened> {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const editor = await withoutLeakedCtxTimers(() =>
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, markdown);
        ctx.update(remarkStringifyOptionsCtx, (options) => {
          const text = options.handlers?.text;
          if (!text) return options;
          return {
            ...options,
            handlers: {
              ...options.handlers,
              text: withNarrowedEscapes(text),
              link: bareUrlLinkHandler((md) => ctx.get(remarkCtx).parse(md)),
            },
          };
        });
      })
      .use(commonmarkWithCompat())
      .use(gfmWithCompat())
      .create(),
  );
  const links = linksOf(editor.ctx.get(editorViewCtx).state.doc);
  const saved = editor.action(getMarkdown());
  await editor.destroy();
  root.remove();
  return { saved, links };
}

/** Save `markdown`, reopen the save: the links must be the ones it had. */
async function reopenKeepsLinks(markdown: string): Promise<string> {
  const first = await open(markdown);
  const second = await open(first.saved);
  expect(second.links, `saved as ${JSON.stringify(first.saved)}`).toEqual(first.links);
  return first.saved;
}

describe('a bare URL is written bare only when it reads back as the same link', () => {
  it('keeps a URL inside emphasis whose closer is followed by escaped punctuation (RC-104)', async () => {
    // The literal ends at `)` on open (GFM trims `)_***`), but once the `*`s
    // are escaped the `\` stops that trimming — a bare save would hand the
    // link everything up to the space.
    await reopenKeepsLinks('_x (https://a.com)_*** y\n');
  });

  it('keeps a URL that is the last thing inside emphasis', async () => {
    await reopenKeepsLinks('_see https://a.com_\\*\\* y\n');
  });

  it('keeps the stock form straight after a mark, whose closer may encode its neighbour', async () => {
    // Bare, `**Note:**https://…` would not close the bold, so the attention
    // encoding would write the URL's `h` as `&#x68;`; and a mark told a bare
    // URL follows encodes its own edge (`_a&#x62;_`).
    expect(await reopenKeepsLinks('**Note:**<https://a.com> y\n')).toBe(
      '**Note:**<https://a.com> y\n',
    );
    expect(await reopenKeepsLinks('_ab_<https://a.com> y\n')).toBe('_ab_<https://a.com> y\n');
  });

  it('writes an autolink with a backslash bare with the same href', async () => {
    // `reopenKeepsLinks` compares the links the `<…>` source opened with to
    // the ones its bare save reopens with.
    expect(await reopenKeepsLinks('see <https://example.com/a\\.b> here\n')).toBe(
      'see https://example.com/a\\.b here\n',
    );
    expect(await reopenKeepsLinks('see <https://example.com/a\\> here\n')).toBe(
      'see https://example.com/a\\ here\n',
    );
  });

  it('still writes the common cases bare', async () => {
    expect(await reopenKeepsLinks('see https://a.com here\n')).toBe('see https://a.com here\n');
    expect(await reopenKeepsLinks('see https://a.com.\n')).toBe('see https://a.com.\n');
    expect(await reopenKeepsLinks('see https://a.com, then\n')).toBe('see https://a.com, then\n');
    expect(await reopenKeepsLinks('go to www.example.com.\n')).toBe('go to www.example.com.\n');
    expect(await reopenKeepsLinks('(https://a.com/x) y\n')).toBe('(https://a.com/x) y\n');
    expect(await reopenKeepsLinks('https://a.com\n')).toBe('https://a.com\n');
  });
});
