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
import { tableNodes } from '@milkdown/kit/prose/tables';

/*
 * The preset builds its table nodes by renaming/reshaping the output of
 * prosemirror-tables' `tableNodes()` (preset-gfm src/node/table/schema.ts);
 * mirror that here rather than hand-writing the specs, because
 * prosemirror-tables' own commands (`addRow`, `selectedRect`) read the
 * generated `tableRole` / colspan attrs off the specs. Node ORDER matters:
 * `table_row` must register after `table_header_row` so
 * `tableNodeTypes(schema).row` resolves to the body-row type, exactly as it
 * does in the real preset's schema array.
 */
const pmTableSpecs = tableNodes({
  tableGroup: 'block',
  cellContent: 'paragraph',
  cellAttributes: {},
});

export const testSchema = new Schema({
  nodes: {
    /* `frontmatter? block+`, exactly as the shipping schema narrows it (see
     * packages/editor/src/milkdown-compat/frontmatter.ts): the front matter
     * block is pinned to the document's first position and is deliberately NOT
     * in group `block`, which is what makes that a restriction. */
    doc: { content: 'frontmatter? block+' },
    frontmatter: { atom: true, selectable: false, attrs: { value: { default: '' } } },
    paragraph: { group: 'block', content: 'inline*' },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { level: { default: 1 } },
    },
    blockquote: { group: 'block', content: 'block+' },
    bullet_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { spread: { default: false } },
    },
    ordered_list: {
      group: 'block',
      content: 'list_item+',
      attrs: { order: { default: 1 }, spread: { default: false } },
    },
    list_item: {
      content: 'paragraph block*',
      defining: true,
      attrs: {
        checked: { default: null },
        label: { default: '\u2022' },
        listType: { default: 'bullet' },
        spread: { default: true },
      },
    },
    horizontal_rule: { group: 'block' },
    // `code: true` and `marks: ''` mirror the preset's code_block: nothing
    // inside a fence is markup, which is what the tag scanner keys off.
    code_block: { group: 'block', content: 'text*', marks: '', code: true },
    // `atom` + the alt/title attrs mirror the commonmark preset's image node,
    // which the vault-image node view reads.
    image: {
      inline: true,
      group: 'inline',
      atom: true,
      attrs: { src: { default: '' }, alt: { default: '' }, title: { default: '' } },
    },
    hardbreak: { group: 'inline', inline: true },
    // GFM tables, shaped like the preset's: one header row, then body rows.
    table: { ...pmTableSpecs.table, content: 'table_header_row table_row+' },
    table_header_row: { ...pmTableSpecs.table_row, content: 'table_header*' },
    table_row: { ...pmTableSpecs.table_row, content: 'table_cell*' },
    table_header: pmTableSpecs.table_header,
    table_cell: pmTableSpecs.table_cell,
    text: { group: 'inline' },
  },
  marks: {
    strong: {},
    emphasis: {},
    strike_through: {},
    inlineCode: { code: true },
    link: { attrs: { href: { default: '' } } },
  },
});
