/*
 * A minimal ProseMirror schema for the milkdown/ unit tests.
 *
 * The node and mark NAMES are the ones Milkdown's commonmark + gfm presets use
 * (`list_item.checked`, `strike_through`, `emphasis`), because the code under
 * test matches on exactly those strings. It is deliberately not the real
 * Milkdown schema: building that needs a full editor with a DOM, and these
 * tests are about the document logic, not the presets. A preset rename would
 * therefore slip past these tests and be caught by
 * `tests/editor-embed-milkdown.spec.ts`, which drives the real bundle.
 */
import { Schema } from '@milkdown/kit/prose/model';

export const testSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
    },
    blockquote: { group: 'block', content: 'block+' },
    bullet_list: { group: 'block', content: 'list_item+' },
    ordered_list: { group: 'block', content: 'list_item+' },
    list_item: {
      content: 'paragraph block*',
      attrs: { checked: { default: null } },
    },
    horizontal_rule: { group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
    emphasis: {},
    strike_through: {},
    link: { attrs: { href: { default: '' } } },
  },
});
