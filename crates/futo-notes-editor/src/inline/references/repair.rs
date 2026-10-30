//! Preserve a retained literal body when its actual new container admits a definition.
use super::*;
use crate::EditorError;

pub(crate) struct RetainedBody {
    pub before: Range<usize>,
    pub after: Range<usize>,
}

struct Repair {
    opener: usize,
    range: Range<usize>,
    inserted: String,
}

impl super::super::Projection {
    pub(crate) fn protect_exposed_definitions(
        &self,
        source: &ropey::Rope,
        origin: Option<&SourceOrigin>,
        range: Range<usize>,
        output: &mut String,
        bodies: &[RetainedBody],
    ) -> Result<(ReferenceWork, usize), EditorError> {
        let mut work = ReferenceWork::default();
        let mut copied = 0;
        if bodies.is_empty() {
            return Ok((work, copied));
        }
        // This is the final physical replacement, including retained wrappers.
        let (local, parsed) = declarations(output, &[]);
        work = parsed;
        let mut repairs = Vec::new();
        for definition in local {
            for body in bodies {
                work.items += 1;
                if !body.after.contains(&definition.range.start) {
                    continue;
                }
                let before = source.byte_slice(body.before.clone()).to_string();
                copied += before.len();
                let after = output
                    .get(body.after.clone())
                    .ok_or(EditorError::UnrepresentableFormat)?;
                if !same_bytes(&before, after, &mut work.items) {
                    return Err(EditorError::UnrepresentableFormat);
                }
                let old = body.before.start + definition.range.start - body.after.start;
                let (row, base, _, visits) = self.rows.source_row_with_work(old);
                work.items += visits;
                let at = old - base;
                let mut literal = false;
                for segment in &row.segments {
                    work.items += 1;
                    literal |= segment.identity && segment.source.contains(&at);
                }
                let mut semantic = None;
                for span in &row.spans {
                    work.items += 1;
                    if let super::super::row::SpanKind::Link(target) = &span.kind {
                        if span.open.contains(&at) {
                            literal = false;
                            if span.open.start == at
                                && body.before.start <= base + span.close.start
                                && base + span.close.end <= body.before.end
                            {
                                let open = source
                                    .byte_slice(base + span.open.start..base + span.open.end)
                                    .to_string();
                                let close = source
                                    .byte_slice(base + span.close.start..base + span.close.end)
                                    .to_string();
                                copied += open.len() + close.len();
                                if let Some(inserted) = super::super::spelling::full_reference_close(
                                    target, &open, &close,
                                ) {
                                    work.copied += inserted.len();
                                    let start = body.after.start + base + span.close.start
                                        - body.before.start;
                                    semantic = Some(Repair {
                                        opener: definition.range.start,
                                        range: start..start + close.len(),
                                        inserted,
                                    });
                                }
                            }
                        }
                    }
                }
                for existing in &row.definitions {
                    work.items += 1;
                    if existing.range.contains(&at) {
                        return Err(EditorError::UnrepresentableFormat);
                    }
                }
                if let Some(repair) = semantic {
                    repairs.push(repair);
                } else if !literal || output.as_bytes().get(definition.range.start) != Some(&b'[') {
                    return Err(EditorError::UnrepresentableFormat);
                } else {
                    repairs.push(Repair {
                        opener: definition.range.start,
                        range: definition.range.start..definition.range.start,
                        inserted: "\\".into(),
                    });
                }
                break;
            }
        }
        if repairs.is_empty() {
            return Ok((work, copied));
        }
        // Escalation follows a structurally changed declaration witness. Build
        // its real parent candidate from the persistent exact source generation.
        let (canonical, base) = if let Some(origin) = origin {
            (origin.source.clone(), origin.start)
        } else if self.references_complete {
            (source.clone(), 0)
        } else {
            return Err(EditorError::UnrepresentableFormat);
        };
        let candidate = |replacement: &str| {
            let mut candidate = canonical.clone();
            let start = candidate.byte_to_char(base + range.start);
            let end = candidate.byte_to_char(base + range.end);
            candidate.remove(start..end);
            candidate.insert(start, replacement);
            candidate.to_string()
        };
        let raw = candidate(output);
        copied += raw.len() + output.len();
        let (actual, actual_work) = declarations(&raw, &[]);
        work.parsed += actual_work.parsed;
        work.items += actual_work.items;
        work.copied += actual_work.copied;
        repairs.retain(|repair| {
            actual.iter().any(|definition| {
                work.items += 1;
                definition.range.start == base + range.start + repair.opener
            })
        });
        if repairs.is_empty() {
            return Ok((work, copied));
        }
        // Canonical declaration traversal is source ordered. Earlier insertions
        // cannot move the remaining offsets when repairs run in reverse.
        for pair in repairs.windows(2) {
            work.items += 1;
            if pair[0].range.end > pair[1].range.start {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        for repair in repairs.into_iter().rev() {
            copied += output.len() - repair.range.end + repair.inserted.len();
            output.replace_range(repair.range, &repair.inserted);
        }
        let repaired = candidate(output);
        copied += repaired.len() + output.len();
        let (references, _, reference_work) = References::scan(&repaired);
        work.parsed += reference_work.parsed;
        work.items += reference_work.items;
        work.copied += reference_work.copied;
        work.items += references.targets.len()
            + self.references.targets.len()
            + references.uses.len()
            + self.references.uses.len();
        for (key, target) in &references.targets {
            work.items += key.as_ref().len()
                + target.destination.len()
                + target.title.as_ref().map_or(0, String::len);
        }
        if references.targets != self.references.targets || references.uses != self.references.uses
        {
            return Err(EditorError::UnrepresentableFormat);
        }
        let (winners, visits) = self.reference_winners(range.clone());
        let checked =
            super::super::Projection::with_references(output, references, &winners, visits);
        work.parsed += checked.initial_parse_work;
        work.items += checked.initial_link_metadata_items;
        work.copied += checked.initial_link_copied_bytes;
        let mut display_at = |at| {
            let (row, base, display, visits) = self.rows.source_row_with_work(at);
            let (offset, segments) = row.display_at_with_work(at - base);
            work.items += visits + segments;
            display + offset
        };
        let old_start = display_at(range.start);
        let old_end = display_at(range.end);
        let old = self.display.byte_slice(old_start..old_end).to_string();
        let new = checked.display.to_string();
        copied += old.len() + new.len();
        if !same_bytes(&old, &new, &mut work.items) {
            return Err(EditorError::UnrepresentableFormat);
        }
        // The unchanged visible body also preserves this slice's returned
        // display endpoints; source history is captured from the final edit.
        Ok((work, copied))
    }
}

fn same_bytes(before: &str, after: &str, work: &mut usize) -> bool {
    before.len() == after.len()
        && before.bytes().zip(after.bytes()).all(|(a, b)| {
            *work += 1;
            a == b
        })
}
