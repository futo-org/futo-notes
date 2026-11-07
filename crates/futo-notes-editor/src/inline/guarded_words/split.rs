//! One actual inserted structural break retires its complete old URI owner.
use super::*;
use crate::inline::{
    edit::EditIntent,
    references::ReferenceWork,
    row::SpanKind,
    spelling::{Piece, PieceOrigin},
    Projection,
};

pub(crate) struct ValidationAtom {
    pub source: Range<usize>,
    pub displayed: String,
    pub identity: bool,
    pub code: bool,
}
impl ValidationAtom {
    pub(crate) fn source_step(
        &mut self,
        base: usize,
        edit: &Range<usize>,
        inserted: usize,
    ) -> Result<usize, EditorError> {
        let start = base
            .checked_add(edit.start)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let end = base
            .checked_add(edit.end)
            .ok_or(EditorError::UnrepresentableFormat)?;
        if end <= self.source.start {
            self.source.start = self
                .source
                .start
                .checked_sub(edit.len())
                .and_then(|at| at.checked_add(inserted))
                .ok_or(EditorError::UnrepresentableFormat)?;
            self.source.end = self
                .source
                .end
                .checked_sub(edit.len())
                .and_then(|at| at.checked_add(inserted))
                .ok_or(EditorError::UnrepresentableFormat)?;
        } else if self.source.end > start {
            return Err(EditorError::UnrepresentableFormat);
        }
        Ok(4)
    }
}
pub(crate) struct SplitInventory {
    pub identity: Arc<CodeWordIdentity>,
    pub atoms: Vec<ValidationAtom>,
}
impl GuardState {
    pub(in crate::inline) fn prepare_split(
        &mut self,
        pieces: &[Piece],
        selected: Range<usize>,
        inserted: &str,
        intent: EditIntent,
    ) -> Result<(Option<usize>, usize), EditorError> {
        if self.owners.is_empty()
            || !selected.is_empty()
            || inserted.is_empty()
            || intent.action() != Some(crate::InputAction::Isolated)
        {
            return Ok((None, 0));
        }
        let mut work = 1;
        if !inserted.bytes().all(|byte| {
            work += 1;
            matches!(byte, b'\r' | b'\n')
        }) {
            return Ok((None, work));
        }
        let mut current = None;
        let mut at = 0;
        let mut candidate = None;
        for piece in pieces {
            work += 1;
            let end = at + piece.display.len();
            match (piece.guard, current) {
                (Some(part), None) if part.role == GuardRole::Open => {
                    current = Some((
                        part.id,
                        end,
                        matches!(piece.origin, Some(PieceOrigin::Source(_))),
                    ))
                }
                (Some(part), Some((id, start, valid)))
                    if part.id == id && part.role == GuardRole::Inner =>
                {
                    current = Some((
                        id,
                        start,
                        valid && matches!(piece.origin, Some(PieceOrigin::Source(_))),
                    ));
                }
                (Some(part), Some((id, start, valid)))
                    if part.id == id && part.role == GuardRole::Close =>
                {
                    work += 4;
                    if start < selected.start && selected.start < at {
                        if !valid
                            || !matches!(piece.origin, Some(PieceOrigin::Source(_)))
                            || candidate.is_some()
                        {
                            return Err(EditorError::UnrepresentableFormat);
                        }
                        candidate = Some(id);
                    }
                    current = None;
                }
                (_, Some((id, start, _))) if !piece.display.is_empty() => {
                    current = Some((id, start, false))
                }
                _ => {}
            }
            at = end;
        }
        self.after_split = candidate;
        Ok((candidate, work))
    }
}
impl Projection {
    /// Capture the complete current owned text inventory before any step can
    /// discard an unmapped witness. Formatting marker bytes are not atoms.
    pub(crate) fn split_guard_inventory(
        &self,
    ) -> Result<(Vec<SplitInventory>, ReferenceWork), EditorError> {
        let mut result = Vec::new();
        let mut work = ReferenceWork::default();
        // Called only by the bounded derived body, never the outer whole note.
        for index in 0..self.rows.len() {
            let (row, base, _, nodes) = self.rows.at_with_work(index);
            work.items += nodes;
            for word in &row.guarded_words {
                let mut atoms = Vec::new();
                work.items += 1;
                for segment in &row.segments {
                    work.items += 1;
                    if segment.source.end <= word.envelope.start
                        || word.envelope.end <= segment.source.start
                    {
                        continue;
                    }
                    if segment.source.start < word.envelope.start
                        || word.envelope.end < segment.source.end
                    {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                    if segment.display.is_empty() {
                        continue;
                    }
                    let code = row.spans.iter().any(|span| {
                        work.items += 1;
                        span.kind == SpanKind::Format(crate::InlineFormat::Code)
                            && span.open.end <= segment.source.start
                            && segment.source.end <= span.close.start
                    });
                    let shown = &row.display[segment.display.clone()];
                    if segment.identity {
                        for (offset, ch) in shown.char_indices() {
                            let displayed = ch.to_string();
                            work.items += 4;
                            work.copied += displayed.len();
                            atoms.push(ValidationAtom {
                                source: base + segment.source.start + offset
                                    ..base + segment.source.start + offset + ch.len_utf8(),
                                displayed,
                                identity: true,
                                code,
                            });
                        }
                    } else {
                        work.items += 4;
                        work.copied += shown.len();
                        atoms.push(ValidationAtom {
                            source: base + segment.source.start..base + segment.source.end,
                            displayed: shown.into(),
                            identity: false,
                            code,
                        });
                    }
                }
                if atoms.is_empty() {
                    return Err(EditorError::UnrepresentableFormat);
                }
                result.push(SplitInventory {
                    identity: word.identity.clone(),
                    atoms,
                });
            }
        }
        Ok((result, work))
    }
    /// Validate actual final source atoms. This grants no transient authority.
    pub(crate) fn validate_split_atoms(
        &self,
        atoms: &[ValidationAtom],
        base: usize,
    ) -> Result<usize, EditorError> {
        let mut work = 0;
        for atom in atoms {
            work += 2;
            let start = atom
                .source
                .start
                .checked_sub(base)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let end = atom
                .source
                .end
                .checked_sub(base)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let (row, source, _, nodes) = self.rows.source_row_with_work(start);
            work += nodes;
            if end > source + row.source_len {
                return Err(EditorError::UnrepresentableFormat);
            }
            let local = start - source..end - source;
            let index = row.segments.partition_point(|segment| {
                work += 1;
                segment.source.end <= local.start
            });
            let segment = row
                .segments
                .get(index)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let shown = if atom.identity
                && segment.identity
                && segment.source.start <= local.start
                && local.end <= segment.source.end
            {
                row.display.get(
                    segment.display.start + local.start - segment.source.start
                        ..segment.display.start + local.end - segment.source.start,
                )
            } else if !atom.identity && !segment.identity && segment.source == local {
                row.display.get(segment.display.clone())
            } else {
                None
            }
            .ok_or(EditorError::UnrepresentableFormat)?;
            if shown.len() != atom.displayed.len()
                || !shown.bytes().zip(atom.displayed.bytes()).all(|(a, b)| {
                    work += 1;
                    a == b
                })
            {
                return Err(EditorError::UnrepresentableFormat);
            }
            let mut code = false;
            for span in &row.spans {
                work += 1;
                if matches!(span.kind, SpanKind::Link(_))
                    && span.open.start < local.end
                    && local.start < span.close.end
                {
                    return Err(EditorError::UnrepresentableFormat);
                }
                code |= span.kind == SpanKind::Format(crate::InlineFormat::Code)
                    && span.open.end <= local.start
                    && local.end <= span.close.start;
            }
            if code != atom.code {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(work)
    }
}
