// @vitest-environment jsdom
import { beforeAll, expect, it } from 'vitest';
import { Engine } from './engine';
import { LineModel } from './lineModel';
import { segmentsOf } from './lineSegments';
import { loadEngineBuild } from './__test__/loadEngineBuild';

beforeAll(loadEngineBuild);

async function linesOf(source: string): Promise<LineModel['lines']> {
  const engine = await Engine.restore({ token: 1, source, revision: 0, paused: false });
  const { lines } = LineModel.from(engine.projectAll());
  engine.free();
  return lines;
}

it('draws a wikilink in the formats of the text around it, as a link label', async () => {
  const lines = await linesOf('**a [[x]] b**\n*a [[x]]*\n~~[[x]] b~~\n[[x]] **b**');
  const wikilinkClasses = lines.map((line) =>
    segmentsOf(line)
      .filter((segment) => segment.className.includes('wikilink'))
      .map((segment) => segment.className),
  );
  expect(wikilinkClasses).toEqual([
    ['atom wikilink unresolved bold'],
    ['atom wikilink unresolved italic'],
    ['atom wikilink unresolved strike'],
    ['atom wikilink unresolved'],
  ]);
});
