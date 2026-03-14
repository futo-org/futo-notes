import { describe, expect, it } from 'vitest';
import { buildGraphClusters, type GraphClusterInput } from './graphLayout';

function makeEntry(
  noteId: string,
  title: string,
  tags: string[],
  vector: number[],
  x: number,
  y: number,
): GraphClusterInput {
  return {
    noteId,
    title,
    preview: `${title} preview`,
    tags,
    vector,
    x,
    y,
  };
}

describe('buildGraphClusters', () => {
  it('creates deterministic semantic clusters with readable labels', () => {
    const entries: GraphClusterInput[] = [
      makeEntry('recipe-1', 'Carnitas Recipe', ['recipes'], [0.95, 0.04, 0.01], -90, 40),
      makeEntry('recipe-2', 'Pot Roast Recipe', ['recipes'], [0.93, 0.06, 0.01], -86, 45),
      makeEntry('recipe-3', 'Short Rib Nihari', ['recipes'], [0.92, 0.05, 0.03], -82, 38),
      makeEntry('recipe-4', 'Sunday Braise', ['recipes'], [0.94, 0.04, 0.02], -88, 34),
      makeEntry('stonefruit-1', 'Stonefruit Presentation Thoughts', ['stonefruit'], [0.05, 0.92, 0.03], 35, -65),
      makeEntry('stonefruit-2', 'Stonefruit Skills Marketplace', ['stonefruit'], [0.04, 0.94, 0.02], 41, -70),
      makeEntry('stonefruit-3', 'Stonefruit CLI', ['stonefruit'], [0.06, 0.91, 0.03], 38, -58),
      makeEntry('stonefruit-4', 'Stonefruit Domains', ['stonefruit'], [0.05, 0.9, 0.05], 31, -61),
      makeEntry('personal-1', 'Gift ideas', ['personal'], [0.04, 0.08, 0.88], 82, 66),
      makeEntry('personal-2', 'justincore', ['personal'], [0.03, 0.09, 0.88], 87, 71),
      makeEntry('personal-3', 'Family errands', ['personal'], [0.02, 0.08, 0.9], 89, 63),
      makeEntry('personal-4', 'Weekend plans', ['personal'], [0.04, 0.07, 0.89], 84, 69),
    ];

    const first = buildGraphClusters(entries);
    const second = buildGraphClusters(entries);

    expect(first).toEqual(second);
    expect(first.map((cluster) => cluster.label)).toEqual(expect.arrayContaining([
      'Recipe',
      'Stonefruit',
      'Personal',
    ]));
    expect(first.every((cluster) => cluster.noteIds.length >= 3)).toBe(true);
  });

  it('filters filler words out of fallback labels', () => {
    const entries: GraphClusterInput[] = [
      makeEntry('a', 'The Alfred Loomi Product', [], [0.9, 0.08, 0.02], 0, 0),
      makeEntry('b', 'Had Alfred Loomi Notes', [], [0.91, 0.07, 0.02], 4, 1),
      makeEntry('c', 'The Loomi Product Plan', [], [0.92, 0.06, 0.02], 8, 0),
      makeEntry('d', 'Alfred Loomi Roadmap', [], [0.89, 0.09, 0.02], 7, 4),
    ];

    const [cluster] = buildGraphClusters(entries);

    expect(cluster.label).not.toMatch(/\b(The|Had)\b/);
    expect(cluster.label).toMatch(/Alfred|Loomi/);
  });
});
