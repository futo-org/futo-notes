//! Preserve marker spelling, repair delimiter boundaries and verify candidates
//! against the CommonMark parser before any source is accepted.
mod boundaries;
mod pieces;
use boundaries::{escape_literal_delimiters, repair_boundaries, repair_literal_boundaries};
use nesting::swap_emphasis_nesting;
mod nesting;
mod reading;
mod render;
mod spans;
pub(super) use pieces::{full_reference_close, Marker, Piece, PieceOrigin, Spelling};
use reading::{missing_spans, only_delimiters_hidden, spans_still_cover};
pub(super) use spans::split_block_spans;
use spans::{repair_code_delimiters, split_paragraph_spans, trim_emphasis_edges};
mod guarded;
mod literal_capsules;
mod literal_urls;
mod typed_origins;
pub(in crate::inline) use literal_urls::CodeLiteralColon;
mod url_timing;
use super::row::SpanKind;
use super::row::{Row, Span};
use crate::{EditorError, InlineFormat};
use render::render;
use std::ops::Range;
pub(super) use url_timing::prepare_url_input;

thread_local! {
    static ESCAPE_TYPED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// While held, planned input writes its typed delimiters as escaped literal
/// text: the text joins a paragraph its own row cannot verify.
pub(crate) struct EscapeTypedDelimiters(bool);

impl EscapeTypedDelimiters {
    pub(crate) fn set() -> Self {
        Self(ESCAPE_TYPED.with(|slot| slot.replace(true)))
    }
}

impl Drop for EscapeTypedDelimiters {
    fn drop(&mut self) {
        ESCAPE_TYPED.with(|slot| slot.set(self.0));
    }
}

pub(super) fn spell(
    pieces: Vec<Piece>,
    guards: super::guarded_words::GuardState,
    typed: super::typed_angle::TypedState,
    raw: &str,
    markers: Vec<Marker>,
    insertion: Range<usize>,
    literal: bool,
    references: &std::sync::Arc<super::references::References>,
) -> Result<Spelling, EditorError> {
    spell_with_anchors(
        pieces,
        guards,
        typed,
        raw,
        markers,
        insertion,
        literal,
        references,
        &[],
    )
}

pub(super) fn spell_with_anchors(
    mut pieces: Vec<Piece>,
    guards: super::guarded_words::GuardState,
    typed: super::typed_angle::TypedState,
    raw: &str,
    mut markers: Vec<Marker>,
    insertion: Range<usize>,
    literal: bool,
    references: &std::sync::Arc<super::references::References>,
    anchors: &[usize],
) -> Result<Spelling, EditorError> {
    split_paragraph_spans(&mut pieces);
    trim_emphasis_edges(&mut pieces, &markers);
    repair_code_delimiters(&pieces, &mut markers);
    let expected: String = pieces.iter().map(|piece| piece.display.as_str()).collect();
    let mut rendered = render(&pieces, &markers, insertion.start, insertion.end);
    let mut parsed = 0;
    let mut materialized = 0;
    let mut link_metadata_items = rendered.link_metadata_items;
    let mut link_copied_bytes = 0;
    let mut verified = None;
    let verify_pending = markers.iter().any(|marker| {
        link_metadata_items += 1;
        marker.pending || marker.activate || marker.literal_url
    });
    // A raw typed delimiter is kept only while the parser reads the row as
    // typed: existing formatting still covers its text and no visible text
    // changes beyond delimiters becoming markers. Otherwise it lands as
    // escaped literal text.
    let mut literal = literal;
    let typed_delimiter = pieces[insertion.clone()]
        .iter()
        .any(|piece| piece.display.contains(['*', '_', '~', '`']));
    if !literal && typed_delimiter && ESCAPE_TYPED.with(std::cell::Cell::get) {
        escape_literal_delimiters(&mut pieces, &markers, insertion.clone());
        materialized += render::replace(&mut rendered, &pieces, &markers, insertion.clone());
        link_metadata_items += rendered.link_metadata_items;
        literal = true;
    } else if !literal && typed_delimiter {
        let candidate = Row::candidate(&rendered.text, references, &rendered.winners);
        parsed += candidate.parsed_source_bytes;
        link_metadata_items += candidate.reference_work.items;
        link_copied_bytes += candidate.reference_work.copied;
        if !only_delimiters_hidden(&expected, &candidate.display)
            || !spans_still_cover(&rendered, &candidate, &mut link_metadata_items)
        {
            escape_literal_delimiters(&mut pieces, &markers, insertion.clone());
            materialized += render::replace(&mut rendered, &pieces, &markers, insertion.clone());
            link_metadata_items += rendered.link_metadata_items;
            literal = true;
        }
    }
    if literal || verify_pending || typed.has_literal_proof() {
        let mut candidate = Row::candidate(&rendered.text, references, &rendered.winners);
        parsed += candidate.parsed_source_bytes;
        link_metadata_items += candidate.reference_work.items;
        link_copied_bytes += candidate.reference_work.copied;
        let mut literal_work = super::references::ReferenceWork::default();
        let mut words = literal_urls::Words::read(&pieces, &markers, &rendered, &mut literal_work)?;
        let mut rendered_changed = false;
        if words.repair(
            &mut pieces,
            &markers,
            &rendered,
            &candidate,
            &mut literal_work,
        )? {
            materialized += render::replace(&mut rendered, &pieces, &markers, insertion.clone());
            rendered_changed = true;
            link_metadata_items += rendered.link_metadata_items;
            candidate = Row::candidate(&rendered.text, references, &rendered.winners);
            parsed += candidate.parsed_source_bytes;
            link_metadata_items += candidate.reference_work.items;
            link_copied_bytes += candidate.reference_work.copied;
        }
        for near_only in [true, false] {
            if candidate.display == expected {
                break;
            }
            repair_literal_boundaries(&mut pieces, &rendered, &candidate, &insertion, near_only);
            // A speculative line-start marker must reopen as the literal text
            // the writer still sees. The block shortcut replaces this spelling
            // only when its final triggering character arrives. Code shows
            // its contents verbatim, so a marker typed into it stays as is.
            for piece in &mut pieces[insertion.clone()] {
                if piece.raw == piece.display
                    && !piece
                        .spans
                        .iter()
                        .any(|&id| markers[id].kind == SpanKind::Format(InlineFormat::Code))
                    && piece
                        .display
                        .chars()
                        .all(|ch| matches!(ch, '#' | '>' | '*' | '_' | '-'))
                {
                    piece.raw = piece
                        .display
                        .chars()
                        .map(|ch| format!("&#{};", ch as u32))
                        .collect();
                }
            }
            if words.has_owners() {
                rendered_changed = true;
            }
            materialized += render::replace(&mut rendered, &pieces, &markers, insertion.clone());
            link_metadata_items += rendered.link_metadata_items;
            candidate = Row::candidate(&rendered.text, references, &rendered.winners);
            parsed += candidate.parsed_source_bytes;
            link_metadata_items += candidate.reference_work.items;
            link_copied_bytes += candidate.reference_work.copied;
        }
        let mut missing: Vec<_> = missing_spans(&rendered, &candidate, &mut link_metadata_items);
        // A bare/autolink spelling is valid only while it reopens with the
        // retained destination. Editing its label can require explicit syntax.
        let mut repaired_link = false;
        for &id in &missing {
            let marker = &mut markers[id];
            if let SpanKind::Link(destination) = &marker.kind {
                if let Some(close) = full_reference_close(destination, &marker.open, &marker.close)
                {
                    // Parser-normalized reference keys preserve their original
                    // source escapes. A full tail retains identity when the
                    // shortcut/collapsed label changes, without editing its
                    // separate definition or making it newly unused.
                    link_copied_bytes += close.len() - 3;
                    marker.close = close;
                    link_metadata_items += 1;
                    repaired_link = true;
                } else if marker.open.is_empty() && marker.close.is_empty()
                    || marker.open == "<" && marker.close == ">"
                {
                    marker.open = "[".into();
                    marker.close = format!(
                        "](<{}>)",
                        super::links::destination_source(&destination.destination)
                    );
                    repaired_link = true;
                }
            }
        }
        if repaired_link {
            if words.has_owners() {
                rendered_changed = true;
            }
            materialized += render::replace(&mut rendered, &pieces, &markers, insertion.clone());
            link_metadata_items += rendered.link_metadata_items;
            candidate = Row::candidate(&rendered.text, references, &rendered.winners);
            parsed += candidate.parsed_source_bytes;
            link_metadata_items += candidate.reference_work.items;
            link_copied_bytes += candidate.reference_work.copied;
            missing = missing_spans(&rendered, &candidate, &mut link_metadata_items);
        }
        if swap_emphasis_nesting(&mut pieces, &markers, &missing) {
            if words.has_owners() {
                rendered_changed = true;
            }
            materialized += render::replace(&mut rendered, &pieces, &markers, insertion.clone());
            link_metadata_items += rendered.link_metadata_items;
            candidate = Row::candidate(&rendered.text, references, &rendered.winners);
            parsed += candidate.parsed_source_bytes;
            link_metadata_items += candidate.reference_work.items;
            link_copied_bytes += candidate.reference_work.copied;
            missing = missing_spans(&rendered, &candidate, &mut link_metadata_items);
        }
        if candidate.display != expected || !missing.is_empty() {
            // An entity changes CommonMark's delimiter flanking while
            // decoding to the same visible scalar. Repair only the exact
            // neighbor of a marker that the library could no longer pair.
            repair_boundaries(&mut pieces, &markers, &missing);
            if words.has_owners() {
                rendered_changed = true;
            }
            materialized += render::replace(&mut rendered, &pieces, &markers, insertion.clone());
            link_metadata_items += rendered.link_metadata_items;
            candidate = Row::candidate(&rendered.text, references, &rendered.winners);
            parsed += candidate.parsed_source_bytes;
            link_metadata_items += candidate.reference_work.items;
            link_copied_bytes += candidate.reference_work.copied;
            let missing: Vec<_> = missing_spans(&rendered, &candidate, &mut link_metadata_items);
            for id in missing {
                let marker = &mut markers[id];
                if matches!(
                    marker.kind,
                    SpanKind::Format(InlineFormat::Bold | InlineFormat::Italic)
                ) {
                    let ch = if marker.open.starts_with('*') {
                        '_'
                    } else {
                        '*'
                    };
                    let width = if marker.kind == SpanKind::Format(InlineFormat::Bold) {
                        2
                    } else {
                        1
                    };
                    marker.open = ch.to_string().repeat(width);
                    marker.close.clone_from(&marker.open);
                }
            }
            if words.has_owners() {
                rendered_changed = true;
            }
            materialized += render::replace(&mut rendered, &pieces, &markers, insertion.clone());
            link_metadata_items += rendered.link_metadata_items;
            candidate = Row::candidate(&rendered.text, references, &rendered.winners);
            parsed += candidate.parsed_source_bytes;
            link_metadata_items += candidate.reference_work.items;
            link_copied_bytes += candidate.reference_work.copied;
            // Last resort: a delimiter the flanking rules cannot keep as
            // formatting is written as escaped literal text, first where it
            // was typed, then wherever a literal delimiter in the row now
            // pairs with something it did not before. Visible text is unchanged.
            for whole_row in [false, true] {
                let mut missing = missing_spans(&rendered, &candidate, &mut link_metadata_items);
                if candidate.display == expected && missing.is_empty() {
                    break;
                }
                let scope = if whole_row {
                    0..pieces.len()
                } else {
                    insertion.clone()
                };
                if !escape_literal_delimiters(&mut pieces, &markers, scope) {
                    continue;
                }
                for repaired in [false, true] {
                    if repaired {
                        repair_boundaries(&mut pieces, &markers, &missing);
                    }
                    materialized +=
                        render::replace(&mut rendered, &pieces, &markers, insertion.clone());
                    link_metadata_items += rendered.link_metadata_items;
                    candidate = Row::candidate(&rendered.text, references, &rendered.winners);
                    parsed += candidate.parsed_source_bytes;
                    link_metadata_items += candidate.reference_work.items;
                    link_copied_bytes += candidate.reference_work.copied;
                    missing = missing_spans(&rendered, &candidate, &mut link_metadata_items);
                    if missing.is_empty() {
                        break;
                    }
                }
                if words.has_owners() {
                    rendered_changed = true;
                }
            }
            if candidate.display != expected
                || !missing_spans(&rendered, &candidate, &mut link_metadata_items).is_empty()
            {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        if rendered_changed {
            words = literal_urls::Words::read(&pieces, &markers, &rendered, &mut literal_work)?;
        }
        words.verify(&pieces, &rendered, &candidate, &mut literal_work)?;
        link_metadata_items += literal_work.items;
        link_copied_bytes += literal_work.copied;
        verified = Some(candidate);
    }
    let mut mapped = Vec::with_capacity(anchors.len());
    for &anchor in anchors {
        let mut at = 0;
        let mut found = None;
        for (piece, source) in pieces.iter().zip(&rendered.pieces) {
            link_metadata_items += 1;
            let end = at + piece.display.len();
            if !piece.display.is_empty() && (anchor == at || anchor == end) {
                found = Some(if anchor == at {
                    source.start
                } else {
                    source.end
                });
                break;
            }
            at = end;
        }
        // With no visible text left there is no piece boundary to anchor to;
        // the only caret is where the edit landed.
        if found.is_none() && anchor == 0 && expected.is_empty() {
            found = Some(rendered.caret);
        }
        mapped.push(found.ok_or(EditorError::UnrepresentableFormat)?);
    }
    if verified.is_none() && (!guards.owners.is_empty() || typed.has_update()) {
        let candidate = Row::candidate(&rendered.text, references, &rendered.winners);
        parsed += candidate.parsed_source_bytes;
        link_metadata_items += candidate.reference_work.items;
        link_copied_bytes += candidate.reference_work.copied;
        verified = Some(candidate);
    }
    let guarded_words = if guards.owners.is_empty() {
        None
    } else {
        Some(
            guards.collect(
                &pieces,
                &markers,
                &rendered,
                verified
                    .as_ref()
                    .ok_or(EditorError::UnrepresentableFormat)?,
                &mut link_metadata_items,
            )?,
        )
    };
    if typed.has_literal_proof() {
        let work = typed.verify_literal_capsules(
            &pieces,
            &rendered,
            verified
                .as_ref()
                .ok_or(EditorError::UnrepresentableFormat)?,
        )?;
        link_metadata_items += work.items;
        link_copied_bytes += work.copied;
    }
    let typed_inputs = typed.emit(&pieces, &rendered, raw, &mut link_metadata_items)?;
    if let Some(origins) = &typed_inputs {
        link_metadata_items += super::typed_angle::validate_row(
            rendered.text.len(),
            verified
                .as_ref()
                .ok_or(EditorError::UnrepresentableFormat)?,
            origins,
        )?;
    }
    let (pending_links, activated_links) =
        url_timing::collect_link_timing(&markers, &rendered, &mut link_metadata_items);
    let split_retirement = guards
        .after_split
        .map(|id| guards.owners[id].as_ref().unwrap().clone());
    link_metadata_items += usize::from(split_retirement.is_some());
    Ok(Spelling {
        literal,
        split_retirement,
        typed_inputs,
        guarded_words,
        materialized,
        pending_links,
        activated_links,
        origins: url_timing::collect_origins(&pieces, &rendered, &mut link_metadata_items),
        input_start: rendered
            .pieces
            .get(insertion.start)
            .map_or(rendered.caret, |range| range.start),
        delimiters: url_timing::collect_delimiters(&pieces, &rendered, &mut link_metadata_items),
        anchors: mapped,
        text: rendered.text,
        caret: rendered.caret,
        parsed,
        link_metadata_items,
        link_copied_bytes,
    })
}
