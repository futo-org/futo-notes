//! Preserve a retained literal body when its actual new container admits a definition.
use super::*;
use crate::EditorError;

pub(crate) struct RetainedBody {
    pub before: Range<usize>,
    pub after: Range<usize>,
}

impl RetainedBody {
    pub(crate) fn ordered(bodies: &[Self]) -> (bool, usize) {
        let mut work = 0;
        let valid = bodies.windows(2).all(|pair| {
            work += 1;
            pair[0].before.end <= pair[1].before.start && pair[0].after.end <= pair[1].after.start
        });
        (valid, work)
    }
}

pub(crate) struct BodyIntent<'a> {
    pub display: &'a str,
    pub regions: &'a [Range<usize>],
    pub caret: usize,
    pub display_caret: usize,
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
        self.protect_body_definitions(source, origin, range, output, bodies, None, None)
            .map(|(work, copied, _)| (work, copied))
    }

    pub(crate) fn protect_body_definitions(
        &self,
        source: &ropey::Rope,
        origin: Option<&SourceOrigin>,
        range: Range<usize>,
        output: &mut String,
        bodies: &[RetainedBody],
        intent: Option<BodyIntent<'_>>,
        mut pending: Option<&mut crate::inline::PendingLinks>,
    ) -> Result<(ReferenceWork, usize, Option<usize>), EditorError> {
        let mut work = ReferenceWork::default();
        let mut copied = 0;
        // This plain command-owned point belongs to the physical output, not
        // a decoded atom or a prior display generation. Preserve it on every
        // no-repair path and return only the exact final validated point.
        let mut caret = intent.as_ref().map(|intent| intent.caret);
        if bodies.is_empty() && intent.is_none() {
            return Ok((work, copied, caret));
        }
        // This is the final physical replacement, including retained wrappers.
        let (local, parsed) = declarations(output, &[]);
        work = parsed;
        work.items += usize::from(caret.is_some());
        let mut repairs = Vec::new();
        for definition in local {
            let mut witnessed = false;
            for body in bodies {
                work.items += 1;
                if !body.after.contains(&definition.range.start) {
                    continue;
                }
                witnessed = true;
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
            if !witnessed {
                if let Some(intent) = &intent {
                    for region in intent.regions {
                        work.items += 1;
                        if region.contains(&definition.range.start) {
                            return Err(EditorError::UnrepresentableFormat);
                        }
                    }
                }
            }
        }
        if repairs.is_empty() {
            return Ok((work, copied, caret));
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
            return Ok((work, copied, caret));
        }
        // Canonical declaration traversal is source ordered. Earlier insertions
        // cannot move the remaining offsets when repairs run in reverse.
        for pair in repairs.windows(2) {
            work.items += 1;
            if pair[0].range.end > pair[1].range.start {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        if let Some(at) = caret {
            work.items += 2;
            if at > output.len() || !output.is_char_boundary(at) {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        if let Some(pending) = &pending {
            if pending.window != (0..output.len()) {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        for repair in repairs.into_iter().rev() {
            if let Some(at) = &mut caret {
                work.items += 2;
                // Left at the start, including insertion exactly at the
                // caret. A nonempty replacement's end remains after it.
                if *at <= repair.range.start {
                } else if repair.range.end <= *at {
                    *at = at
                        .checked_sub(repair.range.len())
                        .and_then(|at| at.checked_add(repair.inserted.len()))
                        .ok_or(EditorError::UnrepresentableFormat)?;
                    work.items += 2;
                } else {
                    // No retained atom/point is inferred inside overwritten
                    // syntax. Its owning correspondence must prove that case.
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
            if let Some(pending) = pending.as_deref_mut() {
                pending.source_step(repair.range.clone(), repair.inserted.len())?;
            }
            copied += output.len() - repair.range.end + repair.inserted.len();
            output.replace_range(repair.range, &repair.inserted);
            if let Some(at) = caret {
                work.items += 2;
                if at > output.len() || !output.is_char_boundary(at) {
                    return Err(EditorError::UnrepresentableFormat);
                }
            }
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
        let old = intent.as_ref().map_or_else(
            || self.display.byte_slice(old_start..old_end).to_string(),
            |intent| intent.display.to_owned(),
        );
        let new = checked.display.to_string();
        copied += old.len() + new.len();
        if !same_bytes(&old, &new, &mut work.items) {
            return Err(EditorError::UnrepresentableFormat);
        }
        if let Some(intent) = intent {
            let (caret, visits) = checked.try_project_source_point(crate::history::SourcePoint {
                source: crate::SourceOffset(caret.ok_or(EditorError::UnrepresentableFormat)?),
                within: 0,
                atom: None,
            });
            work.items += visits;
            if caret != Some(intent.display_caret) {
                return Err(EditorError::UnrepresentableFormat);
            }
        }
        // The unchanged visible body also preserves this slice's returned
        // display endpoints; source history is captured from the final edit.
        Ok((work, copied, caret))
    }
}

fn same_bytes(before: &str, after: &str, work: &mut usize) -> bool {
    before.len() == after.len()
        && before.bytes().zip(after.bytes()).all(|(a, b)| {
            *work += 1;
            a == b
        })
}
