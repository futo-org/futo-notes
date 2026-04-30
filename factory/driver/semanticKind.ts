import type { ElementKind } from './protocol';

// Map a raw CSS class set to one or more semantic ElementKinds. An
// Obsidian element commonly carries multiple semantic classes on the
// same span (e.g. `cm-em cm-strong` for bold+italic, or `cm-link cm-em`
// for an italicized link), so we return an array — the diff buckets by
// kind, and one element should contribute to each bucket it belongs to.
//
// FUTO Notes emits one decoration per concept (a separate bold mark and
// a separate italic mark over the same range), so it normally returns a
// one-element array via the marker/text classes that are exclusive.
//
// Returns `['unknown']` when nothing fits — the caller drops these by
// default (see diff.ts) so they don't pollute buckets.
export function classToKinds(classes: string[]): ElementKind[] {
  const set = new Set(classes);
  const out = new Set<ElementKind>();

  // ---- Markers ----
  // Marker classes win over the text class on the same span; both
  // editors emit text + marker on overlapping ranges. FUTO Notes's
  // marker classes are exclusive (one marker per element) so the order
  // here matters less than for the text classes below.
  if (set.has('cm-md-quote-marker-hidden')) out.add('quote-marker');
  // `cm-blockquote-border` is Obsidian's class on the bare `>` of a
  // level-2+ blockquote (the marker is hidden via `cm-transparent`,
  // and the border is the colored bar that draws the nesting). Map
  // it to `quote-marker` so the bucket diff lines up with SF's
  // level-2+ marker hide. We don't map bare `cm-transparent` because
  // it's used for other hidden markers too (bold/italic markers off
  // cursor) — only the blockquote variant is unambiguous.
  if (set.has('cm-blockquote-border')) out.add('quote-marker');
  if (set.has('cm-formatting')) {
    if (set.has('cm-formatting-strong')) out.add('bold-marker');
    if (set.has('cm-formatting-em')) out.add('italic-marker');
    if (set.has('cm-formatting-strikethrough')) out.add('strikethrough-marker');
    if (set.has('cm-formatting-header')) out.add('heading-marker');
    // `cm-hmd-barelink` co-occurs with `cm-formatting-link` on stray
    // bracket patterns. SF doesn't model these, so skip the bucket.
    if (set.has('cm-formatting-link') && !set.has('cm-hmd-barelink')) out.add('link-marker');
    if (set.has('cm-formatting-link-string')) out.add('link-url');
    if (set.has('cm-formatting-quote')) out.add('quote-marker');
    if (set.has('cm-formatting-code')) out.add('code-fence-marker');
    if (set.has('cm-formatting-list')) out.add('list-marker');
    if (set.has('cm-formatting-hashtag')) out.add('tag');
  }
  for (let n = 1; n <= 6; n++) {
    if (set.has(`cm-md-h${n}-marker`)) out.add('heading-marker');
  }
  if (set.has('cm-md-strong-marker')) out.add('bold-marker');
  if (set.has('cm-md-emphasis-marker')) out.add('italic-marker');
  if (set.has('cm-md-strikethrough-marker')) out.add('strikethrough-marker');
  if (set.has('cm-md-code-marker')) out.add('code-fence-marker');
  if (set.has('cm-md-link-marker')) out.add('link-marker');
  // Bare cm-md-inline-marker (no specialization) — fall back to italic.
  if (out.size === 0 && set.has('cm-md-inline-marker')) out.add('italic-marker');

  // ---- Headings (text) ----
  let leveledHeading = false;
  for (let n = 1; n <= 6; n++) {
    if (set.has(`cm-md-h${n}`) || set.has(`cm-header-${n}`)) {
      out.add(`heading-text-${n}` as ElementKind);
      leveledHeading = true;
    }
  }
  // Only fall back to heading-text-1 when no specific level was found —
  // Obsidian elements carry both `cm-header` and `cm-header-2`, and we
  // don't want to double-count level-1 coverage for non-level-1 headings.
  if (!leveledHeading && (set.has('cm-md-h') || set.has('cm-header'))) out.add('heading-text-1');

  // ---- Inline emphasis ----
  if (set.has('cm-md-strong') || set.has('cm-strong')) out.add('bold-text');
  if (set.has('cm-md-emphasis') || set.has('cm-em')) out.add('italic-text');
  if (set.has('cm-md-strikethrough') || set.has('cm-strikethrough')) out.add('strikethrough-text');

  // ---- Code ----
  if (set.has('cm-md-code-block') || set.has('cm-md-code-block-first') ||
      set.has('cm-md-code-block-middle') || set.has('cm-md-code-block-last') ||
      set.has('cm-md-code-block-single')) out.add('code-block');
  if (set.has('cm-md-code') || set.has('cm-inline-code')) out.add('code-inline');

  // ---- Links / wikilinks ----
  // `cm-hmd-internal-link` is Obsidian's class on the inner text of a
  // replaced wikilink widget. Map it to wikilink so the diff buckets it
  // alongside SF's `cm-md-wikilink`.
  const isWikilink = set.has('cm-md-wikilink') || set.has('cm-hmd-internal-link');
  // `cm-hmd-barelink` is Obsidian's marker for stray `[text]` /
  // `[[unclosed` patterns that look like a link but aren't. SF doesn't
  // model barelinks; skip mapping the underlying `cm-link` / `cm-formatting-link`
  // classes so this product gap doesn't pollute the link buckets.
  const isBarelink = set.has('cm-hmd-barelink');
  if (isWikilink) out.add('wikilink');
  // SF flags bare/angle-bracket URLs with `cm-md-autolink`. Obsidian
  // doesn't have an autolink-specific kind — they're tokenized as
  // regular links with cm-link + cm-url. Map SF's autolink class to
  // link-url so the URL bucket lines up. We drop the dedicated
  // `autolink` kind since the bucket only ever fired on SF.
  const isAutolink = set.has('cm-md-autolink');
  if (isAutolink) out.add('link-url');
  // SF's wikilink decoration carries `cm-md-link cm-md-wikilink`; the
  // outer link-text class is internal styling only — Obsidian doesn't
  // emit a link-text on wikilinks, so suppress it here.
  // SF also emits cm-md-link on autolinks, but Obsidian doesn't put
  // link-text on bare URLs (it's a URL, not a labeled link), so we
  // suppress the link-text mapping in that case too.
  if (!isWikilink && !isBarelink && !isAutolink &&
      (set.has('cm-md-link') || set.has('cm-link'))) out.add('link-text');
  if (set.has('cm-url') || set.has('cm-md-link-url')) out.add('link-url');

  // ---- Lists ----
  // Task widgets / decorations differ structurally between editors:
  // SF emits a checkbox widget at the bullet position; Obsidian emits
  // a checkbox input nested in a label widget at the `[ ]` position
  // when not revealed, or styled raw text when revealed. Keeping them
  // out of the diff buckets avoids penalizing this product-level
  // difference (both render a clickable checkbox; positions differ).
  if (set.has('cm-md-bullet') || set.has('cm-md-number')) out.add('list-marker');

  // ---- Blockquotes ----
  // Obsidian's quote markers carry `cm-formatting-quote cm-quote` on
  // the same span as the `>` glyph. The marker rule above already adds
  // `quote-marker`; suppress the redundant `quote-text` here so the
  // marker glyph isn't double-counted as quoted text.
  const isQuoteMarker = set.has('cm-formatting-quote') || set.has('cm-md-quote-marker') || set.has('cm-md-quote-marker-hidden');
  if (set.has('cm-md-quote-marker')) out.add('quote-marker');
  if (set.has('cm-md-quote-text')) out.add('quote-text');
  if (!isQuoteMarker && (set.has('cm-md-quote') ||
      set.has('cm-md-quote-first') || set.has('cm-md-quote-middle') ||
      set.has('cm-md-quote-last')  || set.has('cm-md-quote-single'))) out.add('quote-text');
  if (!isQuoteMarker && set.has('cm-quote')) out.add('quote-text');

  // ---- Block widgets ----
  if (set.has('cm-md-hr-widget')) out.add('hr-widget');
  // Obsidian renders HR as `<div class="hr cm-line"><hr></div>` —
  // map the `hr` class on a cm-line div, plus the bare `<hr>` tag's
  // emptiness, to hr-widget so the bucket lines up with SF's widget.
  if (set.has('hr') && set.has('cm-line')) out.add('hr-widget');
  if (set.has('cm-md-image-widget') || set.has('cm-md-image-wrapper') ||
      set.has('image-embed') || set.has('image-wrapper')) out.add('image-widget');
  if (set.has('cm-md-table-rendered') || set.has('cm-md-table-wrapper') ||
      set.has('sf-table') || set.has('sf-table__scroll') ||
      set.has('cm-table-widget') || set.has('table-wrapper')) out.add('table-widget');

  // ---- Tags ----
  if (set.has('cm-md-tag')) out.add('tag');
  if (set.has('cm-hashtag') || set.has('cm-hashtag-end') || set.has('cm-hashtag-begin')) out.add('tag');

  if (out.size === 0) return ['unknown'];
  return [...out];
}

// Backwards-compat shim. Prefer classToKinds for new code.
export function classToKind(classes: string[]): ElementKind {
  const kinds = classToKinds(classes);
  return kinds[0];
}
