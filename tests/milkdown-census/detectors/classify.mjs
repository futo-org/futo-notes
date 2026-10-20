/**
 * Turns one note's round trips into its census flags.
 */

import { houseDocument } from './house-document.mjs';
import {
  countBrTags,
  countHtmlTags,
  countWikilinks,
  emptyLinkTargets,
  hasBulletBlockOpener,
  hasInjectedBulletBreak,
  hasInsertedReference,
  leadingFrontMatter,
} from './text-detectors.mjs';

/**
 * Flags for one note. `round1`/`round2`/`round3` are successive `RoundTrip`
 * results from `entry.ts` — `round1` is the body's own load, `round2` is a load
 * of `round1.markdown`, and `round3` is null when the note already settled.
 * (Named in prose rather than imported: this module is loaded by plain Node,
 * which cannot follow a reference into a `.ts` file even a type-only one.)
 *
 * @returns {Record<string, true>}
 */
export function classify({ body, round1, round2, round3 }) {
  const flags = {};

  if (round1.markdown !== round2.markdown) flags.unstable = true;
  if (round3 && round2.markdown !== round3.markdown) flags.unstable_persistent = true;

  // round1.docJson is the document the body parsed to; round2.docJson is what
  // round1 parsed to. Unequal means the editor changed the document, not just
  // its spelling.
  if (JSON.stringify(round1.docJson) !== JSON.stringify(round2.docJson)) flags.doc_mismatch = true;

  /* The two hard gates of the owned serializer (#266). `content_loss` is
   * `doc_mismatch` with only what the house style may change taken out
   * (`houseDocument`): the save dropped or changed something the author wrote.
   * `second_pass_unstable` is the serializer's own fixed point — write, parse
   * with the bare parser, write again — without the editor's load sequence. */
  if (houseDocument(round1.docJson) !== houseDocument(round2.docJson)) flags.content_loss = true;
  if (round1.secondPass !== undefined && round1.secondPass !== round1.markdown) {
    flags.second_pass_unstable = true;
  }
  if (round1.text !== round2.text) flags.text_loss = true;
  if (JSON.stringify(round1.histogram) !== JSON.stringify(round2.histogram)) {
    flags.structural_diff = true;
  }

  if (countBrTags(round1.markdown) < countBrTags(body)) flags.br_loss = true;
  if (
    hasBulletBlockOpener(body) &&
    hasInjectedBulletBreak(round1.markdown) &&
    !hasInjectedBulletBreak(body)
  ) {
    flags.bullet_br_injected = true;
  }

  const emptyLinks = emptyLinkTargets(body);
  if (emptyLinks.length > 0 && emptyLinks.some((url) => !round1.markdown.includes(url))) {
    flags.empty_link_loss = true;
  }

  if (countHtmlTags(round1.markdown) < countHtmlTags(body)) flags.html_loss = true;
  if (countWikilinks(round1.markdown) < countWikilinks(body)) flags.wikilink_loss = true;
  if (hasInsertedReference(body, round1.markdown)) flags.entity_inserted = true;

  /* The one flag here that compares round1 against the ORIGINAL BYTES rather
   * than against round2, and it has to: corrupted front matter is STABLE. With
   * nothing in the parser recognising the construct, `---` parsed as a thematic
   * break and the metadata lines as a setext heading, and `***` + a dash rule
   * round-trips to itself forever — so every stability-based flag above stayed
   * silent while `tags: [a, b]` was being rewritten to `tags: \[a, b]` on disk.
   * That blind spot is why the first census reported "no eaten frontmatter-like
   * content". Byte equality is the right bar for this construct specifically:
   * front matter is not markdown, so there is no re-spelling of it that
   * ADR-0002's normalize-once would accept. */
  const frontMatter = leadingFrontMatter(body);
  if (frontMatter !== null && !round1.markdown.startsWith(frontMatter)) {
    flags.frontmatter_loss = true;
  }

  return flags;
}

export const FLAG_ORDER = [
  'content_loss',
  'second_pass_unstable',
  'unstable',
  'unstable_persistent',
  'doc_mismatch',
  'text_loss',
  'structural_diff',
  'br_loss',
  'bullet_br_injected',
  'empty_link_loss',
  'html_loss',
  'wikilink_loss',
  'frontmatter_loss',
  'entity_inserted',
];
