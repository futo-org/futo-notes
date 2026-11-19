/* Where the `/` menu opens, on lines the real engine reads. */
import { beforeAll, expect, it } from 'vitest';
import { Engine } from './engine';
import { LineModel } from './lineModel';
import { slashRunAt } from './slashRun';
import { loadEngineBuild } from './__test__/loadEngineBuild';

beforeAll(loadEngineBuild);

/** The run with the caret at the end of the note's last display line, or of the first one
 *  whose text is `lineText`. */
async function runAt(source: string, lineText?: string): Promise<ReturnType<typeof slashRunAt>> {
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const { lines } = LineModel.from(engine.projectAll());
  engine.free();
  const line =
    lineText === undefined ? lines[lines.length - 1] : lines.find((one) => one.text === lineText)!;
  return slashRunAt(line, line.text.length);
}

it('opens at a line start, after spaces, and on a heading, quote or list item', async () => {
  expect(await runAt('/')).toEqual({ slash: 0, query: '' });
  expect(await runAt('/hea')).toEqual({ slash: 0, query: 'hea' });
  // An indented plain line's indent is hidden.
  expect(await runAt('  /h1')).toEqual({ slash: 0, query: 'h1' });
  expect(await runAt('text\n/quo')).toEqual({ slash: 0, query: 'quo' });
  expect(await runAt('# /h2')).toEqual({ slash: 0, query: 'h2' });
  expect(await runAt('> /co')).toEqual({ slash: 0, query: 'co' });
  expect((await runAt('- /ta'))?.query).toBe('ta');
});

it('opens after a space mid-line', async () => {
  expect(await runAt('and /')).toEqual({ slash: 4, query: '' });
  expect(await runAt('and /quo')).toEqual({ slash: 4, query: 'quo' });
  expect(await runAt('- item /h')).toMatchObject({ query: 'h' });
});

it('does not open in a word, in a URL, in a fraction, or once a space is typed', async () => {
  expect(await runAt('and/or')).toBeNull();
  expect(await runAt('1/2')).toBeNull();
  expect(await runAt('see /a/b')).toBeNull();
  expect(await runAt('http://')).toBeNull();
  expect(await runAt('/head ')).toBeNull();
});

it('does not open in code, inline code, a table or front matter', async () => {
  expect(await runAt('```\n/\n```', '/')).toBeNull();
  expect(await runAt('`/x`')).toBeNull();
  expect(await runAt('| a | b |\n| - | - |\n| / | c |')).toBeNull();
  expect(await runAt('---\n/\n---\nbody', '/')).toBeNull();
});
