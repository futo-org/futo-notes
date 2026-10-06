/**
 * `[[wikilink]]` support for the Milkdown editor — parse, render, navigate,
 * autocomplete. Writing `[[target]]` back is the editor's own serializer's
 * (`@futo-notes/editor/markdown`), which knows the `wikilink` node.
 *
 * `syntax.ts` documents the survey (#101) that decided the tokenizer is
 * hand-written rather than adopted.
 */
import { remarkWikilink } from './syntax';
import { $remark } from '@milkdown/kit/utils';

import { wikilinkSchema, wikilinkView } from './node';
import { wikilinkInputRule } from './inputRule';
import { wikilinkAutocomplete } from './autocomplete';

export const wikilinkRemark = $remark('remark-futo-wikilink', () => remarkWikilink);

/** Mounted as one `.use(...)` by `editorPlugins.ts`. */
export const wikilink = [
  wikilinkRemark,
  wikilinkSchema,
  wikilinkView,
  wikilinkInputRule,
  wikilinkAutocomplete,
].flat();

export {
  createWikilink,
  isInCode,
  refreshWikilinkViews,
  WIKILINK_NODE,
  WIKILINK_TARGET_ATTR,
  wikilinkSchema,
} from './node';
export { wikilinkDisplay, WIKILINK_CLASS, WIKILINK_BROKEN_CLASS } from './display';
export { WIKILINK_MDAST_TYPE } from './syntax';
