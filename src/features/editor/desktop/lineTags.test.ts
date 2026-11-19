// @vitest-environment jsdom
/* Tags and front matter as the page draws the engine's projection (lineTags.ts, lineModel.ts). */
import { beforeAll, expect, it } from 'vitest';
import { Engine } from './engine';
import { drawLine } from './lineElements';
import { LineModel } from './lineModel';
import { loadEngineBuild } from './__test__/loadEngineBuild';

beforeAll(loadEngineBuild);

async function drawn(source: string): Promise<HTMLElement[]> {
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const model = LineModel.from(engine.projectAll());
  engine.free();
  return model.lines.map((line) => {
    const element = document.createElement('div');
    drawLine(element, line);
    return element;
  });
}

it('colours each tag, after wide characters too, and leaves its text as it is', async () => {
  const [line] = await drawn('héllo 🙂 #work and #play_time');
  expect([...line.querySelectorAll('.tag')].map((tag) => tag.textContent)).toEqual([
    '#work',
    '#play_time',
  ]);
  expect(line.textContent).toBe('héllo 🙂 #work and #play_time');
});

it('draws a tag beside formatted text; inline code holds none', async () => {
  const [line] = await drawn('**bold** #tag and `#code`');
  expect([...line.children].map((span) => [span.className, span.textContent])).toEqual([
    ['bold', 'bold'],
    ['tag', '#tag'],
    ['code', '#code'],
  ]);
});

it('draws front matter lines as metadata, its fences hidden, and the body after it as text', async () => {
  const lines = await drawn('---\ntitle: x #no\n---\n#a\n\nbody');
  expect(lines.map((line) => line.textContent)).toEqual(['title: x #no', '#a', '', 'body']);
  expect(lines.map((line) => line.classList.contains('metadata'))).toEqual([
    true,
    false,
    false,
    false,
  ]);
  expect(lines[0].querySelector('.tag')).toBeNull();
  expect(lines[1].querySelector('.tag')?.textContent).toBe('#a');
});

it('colours a tag in a table cell', async () => {
  const [header, , row] = await drawn('| a | b |\n| - | - |\n| #x | y |');
  expect(header.querySelector('.tag')).toBeNull();
  expect(row.querySelector('.tag')?.textContent).toBe('#x');
});
