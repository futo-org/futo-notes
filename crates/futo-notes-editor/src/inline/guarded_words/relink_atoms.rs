//! Complete semantic atom proofs for a known command-transformed Guard.
use super::relink::CodeWitness;
use super::split::ValidationAtom;
use super::*;
use crate::inline::{row::SpanKind, Projection};
use crate::{EditWork, InlineFormat};

fn under_code(codes: &[CodeWitness], range: &Range<usize>, work: &mut usize) -> bool {
    let at = codes.partition_point(|code| {
        *work += 1;
        code.close.start < range.end
    });
    codes.get(at).is_some_and(|code| {
        *work += 2;
        code.open.end <= range.start && range.end <= code.close.start
    })
}
impl Projection {
    pub(crate) fn capture_relink_guard_atoms(
        &self,
        word: Range<usize>,
        codes: &[CodeWitness],
        origin: usize,
    ) -> Result<(Option<Vec<ValidationAtom>>, EditWork), EditorError> {
        let mut work = EditWork::default();
        let a = word
            .start
            .checked_sub(origin)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let z = word
            .end
            .checked_sub(origin)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let (row, base, _, nodes) = self.rows.source_row_with_work(a);
        work.link_metadata_items += nodes;
        if z > base + row.source_len {
            return Ok((None, work));
        }
        for span in &row.spans {
            work.link_metadata_items += 1;
            if span.open.start < z - base
                && a - base < span.close.end
                && !matches!(span.kind, SpanKind::Format(InlineFormat::Code))
            {
                return Ok((None, work));
            }
        }
        let first = row.segments.partition_point(|part| {
            work.link_metadata_items += 1;
            part.source.end <= a - base
        });
        let mut cursor = a - base;
        let mut atoms = Vec::new();
        for part in &row.segments[first..] {
            work.link_metadata_items += 1;
            if cursor == z - base {
                break;
            }
            if part.source.start != cursor || part.source.end > z - base {
                return Ok((None, work));
            }
            cursor = part.source.end;
            let source = origin + base + part.source.start..origin + base + part.source.end;
            if part.display.is_empty() {
                let index = codes.partition_point(|code| {
                    work.link_metadata_items += 1;
                    code.close.end <= source.start
                });
                let known = codes.get(index).is_some_and(|code| {
                    work.link_metadata_items += 4;
                    code.open.start <= source.start && source.end <= code.open.end
                        || code.close.start <= source.start && source.end <= code.close.end
                });
                if !known {
                    return Ok((None, work));
                }
                continue;
            }
            let code = under_code(codes, &source, &mut work.link_metadata_items);
            let shown = &row.display[part.display.clone()];
            if part.identity {
                for (offset, ch) in shown.char_indices() {
                    let displayed = ch.to_string();
                    work.link_copied_bytes += displayed.len();
                    atoms.push(ValidationAtom {
                        source: source.start + offset..source.start + offset + ch.len_utf8(),
                        displayed,
                        identity: true,
                        code,
                    });
                    work.link_metadata_items += 7;
                }
            } else {
                atoms.push(ValidationAtom {
                    source,
                    displayed: shown.to_owned(),
                    identity: false,
                    code,
                });
                work.link_copied_bytes += shown.len();
                work.link_metadata_items += 7;
            }
        }
        if cursor != z - base || atoms.is_empty() {
            return Ok((None, work));
        }
        Ok((Some(atoms), work))
    }
    /// One row and source-ordered segment walk serves this complete inventory.
    pub(crate) fn validate_relink_guard_atoms(
        &self,
        atoms: &[ValidationAtom],
        codes: &[CodeWitness],
        origin: usize,
    ) -> Result<usize, EditorError> {
        let mut work = 0;
        let Some(first) = atoms.first() else {
            return Err(EditorError::UnrepresentableFormat);
        };
        let a = first
            .source
            .start
            .checked_sub(origin)
            .ok_or(EditorError::UnrepresentableFormat)?;
        let (row, base, _, nodes) = self.rows.source_row_with_work(a);
        work += nodes;
        let base = base + origin;
        let mut segment = row.segments.partition_point(|part| {
            work += 1;
            base + part.source.end <= first.source.start
        });
        for atom in atoms {
            work += 1;
            while segment < row.segments.len()
                && base + row.segments[segment].source.end <= atom.source.start
            {
                segment += 1;
                work += 1;
            }
            let part = row
                .segments
                .get(segment)
                .ok_or(EditorError::UnrepresentableFormat)?;
            let local = atom
                .source
                .start
                .checked_sub(base)
                .ok_or(EditorError::UnrepresentableFormat)?
                ..atom
                    .source
                    .end
                    .checked_sub(base)
                    .ok_or(EditorError::UnrepresentableFormat)?;
            let shown = if atom.identity
                && part.identity
                && part.source.start <= local.start
                && local.end <= part.source.end
            {
                row.display.get(
                    part.display.start + local.start - part.source.start
                        ..part.display.start + local.end - part.source.start,
                )
            } else if !atom.identity && !part.identity && part.source == local {
                row.display.get(part.display.clone())
            } else {
                None
            }
            .ok_or(EditorError::UnrepresentableFormat)?;
            if shown.len() != atom.displayed.len()
                || !shown.bytes().zip(atom.displayed.bytes()).all(|(a, b)| {
                    work += 1;
                    a == b
                })
                || under_code(codes, &atom.source, &mut work) != atom.code
            {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        Ok(work)
    }
}
