/** Parse-side repairs for pinned Milkdown presets; upstream canaries live in the editor-embed compat suites. */
import {
  commonmark,
  createCodeBlockInputRule as upstreamCodeBlockInputRule,
  emphasisStarInputRule as upstreamEmphasisStarInputRule,
  emphasisUnderscoreInputRule as upstreamEmphasisUnderscoreInputRule,
  inlineCodeInputRule as upstreamInlineCodeInputRule,
  inlineNodesCursorPlugin as upstreamInlineNodesCursorPlugin,
  remarkInlineLinkPlugin,
  remarkPreserveEmptyLinePlugin,
  strongInputRule as upstreamStrongInputRule,
  syncHeadingIdPlugin,
  syncListOrderPlugin,
  wrapInHeadingInputRule as upstreamHeadingInputRule,
} from '@milkdown/kit/preset/commonmark';
import {
  gfm,
  keepTableAlignPlugin,
  strikethroughInputRule as upstreamStrikethroughInputRule,
  tableEditingPlugin,
} from '@milkdown/kit/preset/gfm';
import type { MilkdownPlugin } from '@milkdown/kit/ctx';

import { remarkExpandEmptyLinksPlugin } from './emptyLink';
import { remarkInlineHtmlIndentPlugin } from './inlineHtmlIndent';
import { remarkEmptyTaskItemPlugin } from './emptyTaskItem';
import { remarkImageTitlePlugin } from './imageTitle';
import { inlineNodesCursorPlugin } from './inlineNodesCursor';
import {
  createCodeBlockInputRule,
  emphasisStarInputRule,
  emphasisUnderscoreInputRule,
  inlineCodeInputRule,
  strikethroughInputRule,
  strongInputRule,
  wrapInHeadingInputRule,
} from './inputRules';
import { remarkInlineUsedLinkDefinitionsPlugin } from './linkDefinitions';
import { remarkBlankLineParagraphsPlugin } from './emptyLine';
import { frontmatterPlugins } from './frontmatter';
import { frontmatterCaretPlugins } from './frontmatterCaret';
import { scopedListOrderPlugin } from './listOrder';
import { tightListItemSchema } from './listItemSpread';
import { ownedSerializerPlugin } from './ownedSerializer';
import { scopedKeepTableAlignPlugin, scopedTableEditingPlugin } from './tablePasses';
import { tableAlignmentSchemas } from './tableAlignment';
import { tableFillerRowSchema } from './tableFillerRow';
import { remarkPadTableRowsPlugin } from './tableWidth';

export { FRONTMATTER_NODE } from './frontmatter';
export type { MdastNode } from './mdast';
export { editorMarkdownSerializer } from './ownedSerializer';
export { asFillerRow, isUnwrittenFillerRow } from './tableFillerRow';
export { endsInUnwrittenBlank, writtenContentEnd } from './trailingParagraph';

type PresetPatch = readonly [
  upstream: MilkdownPlugin,
  replacement: MilkdownPlugin | null,
  name: string,
];

const COMMONMARK_PATCHES: readonly PresetPatch[] = [
  [remarkPreserveEmptyLinePlugin.options, null, 'empty-line options'],
  [remarkPreserveEmptyLinePlugin.plugin, null, 'empty-line plugin'],
  [remarkInlineLinkPlugin.options, null, 'inline-link options'],
  [remarkInlineLinkPlugin.plugin, null, 'inline-link plugin'],
  // Updating the heading id rebuilds its DOM during typing on WebKit.
  [syncHeadingIdPlugin, null, 'heading-id plugin'],
  [syncListOrderPlugin, null, 'list-order plugin'],
  [upstreamInlineNodesCursorPlugin, inlineNodesCursorPlugin, 'inline-cursor plugin'],
  [upstreamEmphasisStarInputRule, emphasisStarInputRule, 'emphasis-star input rule'],
  [
    upstreamEmphasisUnderscoreInputRule,
    emphasisUnderscoreInputRule,
    'emphasis-underscore input rule',
  ],
  [upstreamStrongInputRule, strongInputRule, 'strong input rule'],
  [upstreamInlineCodeInputRule, inlineCodeInputRule, 'inline-code input rule'],
  [upstreamCodeBlockInputRule, createCodeBlockInputRule, 'code-block input rule'],
  [upstreamHeadingInputRule, wrapInHeadingInputRule, 'heading input rule'],
];

const GFM_PATCHES: readonly PresetPatch[] = [
  [keepTableAlignPlugin, null, 'table-alignment plugin'],
  [tableEditingPlugin, null, 'table-editing plugin'],
  [upstreamStrikethroughInputRule, strikethroughInputRule, 'strikethrough input rule'],
];

/** Preserve event-handler priority and fail closed if an upstream preset changes shape. */
function patchPreset(
  plugins: readonly MilkdownPlugin[],
  patches: readonly PresetPatch[],
  preset: string,
): MilkdownPlugin[] {
  const changes = new Map(
    patches.map(([upstream, replacement, name]) => [upstream, { replacement, name, count: 0 }]),
  );
  const result: MilkdownPlugin[] = [];
  for (const plugin of plugins) {
    const change = changes.get(plugin);
    if (!change) {
      result.push(plugin);
      continue;
    }
    change.count += 1;
    if (change.replacement !== null) result.push(change.replacement);
  }
  for (const { name, count } of changes.values()) {
    if (count !== 1) {
      throw new Error(
        `milkdown-compat: expected one upstream ${name} entry in ${preset}, found ${count}. ` +
          'Re-check the preset composition against this module.',
      );
    }
  }
  return result;
}

let cachedCommonmark: MilkdownPlugin[] | null = null;
let cachedGfm: MilkdownPlugin[] | null = null;

/** The GFM preset with scoped table passes and lossless schema overrides; pair with commonmarkWithCompat(). */
export function gfmWithCompat(): MilkdownPlugin[] {
  cachedGfm ??= [
    ...patchPreset(gfm, GFM_PATCHES, '@milkdown/preset-gfm'),
    scopedKeepTableAlignPlugin,
    scopedTableEditingPlugin,
    // Pad at the end before fixTables can shift values under the wrong header.
    ...remarkPadTableRowsPlugin,
    // Schema overrides must follow the GFM registrations they extend.
    ...tableAlignmentSchemas,
    tableFillerRowSchema,
    tightListItemSchema,
  ];
  return cachedGfm;
}

/**
 * The complete parse-side compat set and owned serializer. Built lazily so a
 * barrel import does not validate the preset or force Milkdown into codegen;
 * memoized to keep plugin identities stable across editors.
 */
export function commonmarkWithCompat(): MilkdownPlugin[] {
  cachedCommonmark ??= [
    ...patchPreset(commonmark, COMMONMARK_PATCHES, '@milkdown/preset-commonmark'),
    ...remarkBlankLineParagraphsPlugin,
    // Restore source-line gaps before deleting used definitions.
    ...remarkInlineUsedLinkDefinitionsPlugin,
    ...remarkExpandEmptyLinksPlugin,
    ...remarkInlineHtmlIndentPlugin,
    ...remarkImageTitlePlugin,
    ...remarkEmptyTaskItemPlugin,
    scopedListOrderPlugin,
    // Frontmatter extends the preset's registered doc schema.
    ...frontmatterPlugins,
    ...frontmatterCaretPlugins,
    ownedSerializerPlugin,
  ];
  return cachedCommonmark;
}
