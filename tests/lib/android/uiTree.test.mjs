import { describe, expect, it } from 'vitest';

import { decodeXmlEntities, describeUiNodes, parseUiNodes } from './uiTree.mjs';

/** Shaped like a real `uiautomator dump`: a container that does not self-close,
 *  leaf nodes that do, and Compose's zero-area measured-but-unplaced nodes. */
const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" bounds="[0,0][320,640]">
    <node index="0" text="All notes" resource-id="" class="android.widget.TextView" clickable="false" enabled="true" bounds="[16,80][140,112]" />
    <node index="1" text="Groceries &amp; sundries" resource-id="" class="android.widget.TextView" clickable="true" enabled="true" bounds="[16,120][300,160]" />
    <node index="2" text="" content-desc="New note" resource-id="com.futo.notes.dev:id/fab" clickable="true" enabled="true" bounds="[250,560][300,610]" />
    <node index="3" text="Disabled row" clickable="true" enabled="false" bounds="[16,200][300,240]" />
    <node index="4" text="Unplaced" bounds="[0,0][0,0]" />
  </node>
</hierarchy>`;

describe('parseUiNodes', () => {
  it('gives every labelled node the centre point to tap', () => {
    const groceries = parseUiNodes(DUMP).find((node) => node.label.startsWith('Groceries'));
    expect(groceries).toMatchObject({
      kind: 'text',
      x: 158,
      y: 140,
      clickable: true,
      enabled: true,
    });
  });

  it('decodes escaped labels so a caller can ask for what it sees', () => {
    const labels = parseUiNodes(DUMP).map((node) => node.label);
    expect(labels).toContain('Groceries & sundries');
  });

  it('reads a content-desc as a label, since icon buttons have no text', () => {
    const fab = parseUiNodes(DUMP).find((node) => node.label === 'New note');
    expect(fab).toMatchObject({
      kind: 'content-desc',
      resourceId: 'com.futo.notes.dev:id/fab',
      x: 275,
      y: 585,
    });
  });

  it('reports a disabled control rather than hiding it, so a test can assert on it', () => {
    expect(parseUiNodes(DUMP).find((node) => node.label === 'Disabled row')).toMatchObject({
      clickable: true,
      enabled: false,
    });
  });

  /** Tapping the centre of a zero-area node hits whatever is at the origin. */
  it('drops zero-area nodes, which have no tappable centre', () => {
    expect(parseUiNodes(DUMP).map((node) => node.label)).not.toContain('Unplaced');
  });

  it('ignores container nodes that carry no label', () => {
    expect(parseUiNodes(DUMP).every((node) => node.label.length > 0)).toBe(true);
  });

  it('returns nothing for a failed dump instead of throwing', () => {
    expect(parseUiNodes('')).toEqual([]);
    expect(parseUiNodes('ERROR: could not get idle state.')).toEqual([]);
  });

  it('lists what was on screen for a timeout message', () => {
    expect(describeUiNodes(parseUiNodes(DUMP))).toBe(
      'All notes | Groceries & sundries | New note | Disabled row',
    );
  });
});

describe('decodeXmlEntities', () => {
  it('decodes the named entities uiautomator emits', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;')).toBe(
      `a & b <c> "d" 'e'`,
    );
  });

  it('decodes numeric and hex references', () => {
    expect(decodeXmlEntities('line&#10;break &#x2026;')).toBe('line\nbreak …');
  });

  it('leaves an unknown entity alone rather than dropping the text', () => {
    expect(decodeXmlEntities('100&nbsp;%')).toBe('100&nbsp;%');
  });
});
