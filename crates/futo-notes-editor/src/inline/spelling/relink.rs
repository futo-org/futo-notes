//! Literal spelling of one originally witnessed, plain pending URI label.
use super::*;
use crate::inline::{references::RetainedBody, PendingLinkWitness, Projection};
use crate::EditWork;
use ropey::Rope;

#[derive(Clone)]
pub(crate) struct RetainedFormat {
    pub format: InlineFormat,
    pub open: Range<usize>,
    pub close: Range<usize>,
}
pub(crate) struct RetiredLinkText {
    pub text: String,
    pub copied: Vec<RetainedBody>,
    pub anchors: Vec<usize>,
    pub formats: Vec<RetainedFormat>,
    pub work: EditWork,
}

impl Projection {
    /// Ownership is the ORIGINAL canonical Link and explicit pending snapshot.
    /// Its label must consist of complete identity atoms; no retained marker
    /// exists inside that opaque/plain label. Outer markers remain outside the
    /// replaced envelope and are copied by the real spelling step's owner.
    pub(crate) fn spell_relinked_pending_uri(
        &self,
        source: &Rope,
        original: &PendingLinkWitness,
        emitted_label: &str,
        anchors: &[usize],
    ) -> Result<RetiredLinkText, EditorError> {
        let mut work = EditWork::default();
        let (row, base, _, nodes) = self.rows.source_row_with_work(original.body.start);
        work.link_metadata_items += nodes;
        if original.body.end > base + row.source_len || emitted_label.contains(['\r', '\n']) {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut cursor = original.body.start - base;
        let end = original.body.end - base;
        let first = row.segments.partition_point(|part| {
            work.link_metadata_items += 1;
            part.source.end <= cursor
        });
        for part in &row.segments[first..] {
            work.link_metadata_items += 2;
            if cursor == end {
                break;
            }
            if !part.identity || part.source.start > cursor || part.source.end <= cursor {
                return Err(EditorError::UnrepresentableFormat);
            }
            cursor = part.source.end.min(end);
        }
        if cursor != end {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut formats = Vec::new();
        for span in &row.spans {
            work.link_metadata_items += 1;
            if let SpanKind::Format(format) = span.kind {
                if base + span.open.start < original.body.end
                    && original.body.start < base + span.close.end
                {
                    if format == InlineFormat::Code {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    formats.push(RetainedFormat {
                        format,
                        open: base + span.open.start..base + span.open.end,
                        close: base + span.close.start..base + span.close.end,
                    });
                    work.link_metadata_items += 5;
                }
            }
        }
        let old = source.byte_slice(original.body.clone()).to_string();
        work.materialized_source_bytes += old.len();
        let (links, read) = crate::inline::links::bare_links(&old);
        work.parsed_source_bytes += read.parsed;
        work.link_metadata_items += read.items + links.len() + 1;
        work.link_copied_bytes += read.copied;
        let valid = links.first().is_some_and(|span| {
            span.open.start == 0 && span.close.end == old.len() && links.len() == 1
                && matches!(&span.kind, SpanKind::Link(meaning) if {
                    work.link_metadata_items += 3;
                    meaning.title.is_none() && meaning.reference.is_none()
                        && original.meaning.title.is_none() && original.meaning.reference.is_none()
                        && meaning.destination.len() == original.meaning.destination.len()
                        && meaning.destination.bytes().zip(original.meaning.destination.bytes()).all(|(a,b)| {
                            work.link_metadata_items += 1; a == b
                        })
                })
        });
        if !valid {
            return Err(EditorError::UnrepresentableFormat);
        }
        let mut pieces: Vec<_> = emitted_label
            .char_indices()
            .map(|(at, ch)| {
                work.link_metadata_items += 1;
                work.link_copied_bytes += 2 * ch.len_utf8();
                Piece {
                    guard: None,
                    physical_prefix: false,
                    literal_url: None,
                    raw: ch.to_string(),
                    display: ch.to_string(),
                    spans: Vec::new(),
                    trailing: false,
                    definition: None,
                    origin: Some(PieceOrigin::Source(at..at + ch.len_utf8())),
                    timing: false,
                }
            })
            .collect();
        if pieces.is_empty() {
            return Err(EditorError::UnrepresentableFormat);
        }
        // Ordinary source punctuation escaping belongs to Spelling, not a
        // pending-link caller. It confers no input or guard provenance.
        let www = emitted_label
            .get(..4)
            .is_some_and(|s| s.eq_ignore_ascii_case("www."));
        let punctuation = pieces
            .iter_mut()
            .find(|piece| {
                work.link_metadata_items += 1;
                piece.display == if www { "." } else { ":" }
            })
            .ok_or(EditorError::UnrepresentableFormat)?;
        punctuation.raw = format!("\\{}", punctuation.display);
        work.link_copied_bytes += punctuation.raw.len();
        let count = pieces.len();
        let mut literal = crate::inline::typed_angle::TypedState::current(Vec::new());
        // This is an operation-only NoLink proof, never has_update/emit.
        literal.literal_capsules.push(0..count);
        let spelled = spell(
            pieces,
            crate::inline::guarded_words::GuardState::default(),
            literal,
            emitted_label,
            Vec::new(),
            count..count,
            true,
            &self.references,
        )?;
        work.materialized_source_bytes += spelled.materialized + spelled.text.len();
        work.parsed_source_bytes += spelled.parsed;
        work.link_metadata_items += spelled.link_metadata_items;
        work.link_copied_bytes += spelled.link_copied_bytes;
        let mut ordered: Vec<_> = anchors.iter().copied().enumerate().collect();
        ordered.sort_unstable_by(|a, b| {
            work.link_metadata_items += 1;
            a.1.cmp(&b.1)
        });
        let mut mapped = vec![0; anchors.len()];
        let mut next = 0;
        let mut copied = Vec::new();
        for (origin, output) in spelled.origins {
            work.link_metadata_items += 1;
            let PieceOrigin::Source(input) = origin else {
                return Err(EditorError::UnrepresentableFormat);
            };
            while next < ordered.len() && ordered[next].1 <= input.end {
                let (index, at) = ordered[next];
                work.link_metadata_items += 2;
                mapped[index] = if at == input.start {
                    output.start
                } else if at == input.end {
                    output.end
                } else {
                    return Err(EditorError::UnrepresentableFormat);
                };
                next += 1;
            }
            let before = emitted_label
                .get(input.clone())
                .ok_or(EditorError::UnrepresentableFormat)?;
            let after = spelled
                .text
                .get(output.clone())
                .ok_or(EditorError::UnrepresentableFormat)?;
            if before.len() == after.len()
                && before.bytes().zip(after.bytes()).all(|(a, b)| {
                    work.link_metadata_items += 1;
                    a == b
                })
            {
                copied.push(RetainedBody {
                    before: input,
                    after: output,
                });
                work.link_metadata_items += 4;
            }
        }
        if next != ordered.len() {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(RetiredLinkText {
            text: spelled.text,
            copied,
            anchors: mapped,
            formats,
            work,
        })
    }
}

impl Projection {
    /// Reconcile all literal results on the same complete final candidate.
    pub(crate) fn validate_retired_link_texts(
        &self,
        proofs: &[(&Range<usize>, &str, &[RetainedFormat])],
        origin: usize,
    ) -> Result<usize, EditorError> {
        let mut work = 0;
        let mut first = 0;
        while first < proofs.len() {
            let at = proofs[first]
                .0
                .start
                .checked_sub(origin)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let (row, base, _, nodes) = self.rows.source_row_with_work(at);
            work += nodes;
            let base = origin + base;
            let last = proofs.partition_point(|proof| {
                work += 1;
                proof.0.start < base + row.source_len
            });
            if last <= first || proofs[last - 1].0.end > base + row.source_len {
                return Err(EditorError::UnrepresentableFormat);
            }
            let mut seen: Vec<Vec<bool>> = proofs[first..last]
                .iter()
                .map(|p| {
                    work += 1 + p.2.len();
                    vec![false; p.2.len()]
                })
                .collect();
            let mut segment = 0;
            for (range, expected, _) in &proofs[first..last] {
                let mut at = range.start - base;
                let end = range.end - base;
                let mut shown = 0;
                while segment < row.segments.len() && row.segments[segment].source.end <= at {
                    work += 1;
                    segment += 1;
                }
                while at < end {
                    work += 3;
                    let part = row
                        .segments
                        .get(segment)
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    if part.source.start > at || part.source.end <= at || part.display.is_empty() {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    let to = part.source.end.min(end);
                    let display = if part.identity {
                        let start = part.display.start + at - part.source.start;
                        start..start + to - at
                    } else {
                        if at != part.source.start || to != part.source.end {
                            return Err(EditorError::UnrepresentableFormat);
                        }
                        part.display.clone()
                    };
                    let actual = row
                        .display
                        .get(display)
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    let wanted = expected
                        .get(shown..shown + actual.len())
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    if !actual.bytes().zip(wanted.bytes()).all(|(a, b)| {
                        work += 1;
                        a == b
                    }) {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    shown += actual.len();
                    at = to;
                    if at == part.source.end {
                        segment += 1;
                    }
                }
                if shown != expected.len() {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            for span in &row.spans {
                work += 1;
                let start = base + span.open.start;
                let end = base + span.close.end;
                let mut index = first
                    + proofs[first..last].partition_point(|p| {
                        work += 1;
                        p.0.end <= start
                    });
                while index < last && proofs[index].0.start < end {
                    work += 1;
                    let SpanKind::Format(format) = span.kind else {
                        return Err(EditorError::UnrepresentableFormat);
                    };
                    if format == InlineFormat::Code {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    let found = proofs[index]
                        .2
                        .iter()
                        .position(|wanted| {
                            work += 1;
                            wanted.format == format
                                && wanted.open == (base + span.open.start..base + span.open.end)
                                && wanted.close == (base + span.close.start..base + span.close.end)
                        })
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    seen[index - first][found] = true;
                    index += 1;
                }
            }
            for found in seen.into_iter().flatten() {
                work += 1;
                if !found {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            first = last;
        }
        Ok(work)
    }
}
