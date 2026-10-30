//! Preserve a retained literal body when its actual new container admits a definition.
use super::*;
use crate::EditorError;

pub(crate) struct RetainedBody {
    pub before: Range<usize>,
    pub after: Range<usize>,
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
        work.items += output.len() * 2; // declaration eligibility byte guards
        let mut openers = Vec::new();
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
                work.items += before.len().min(after.len());
                if before != after {
                    return Err(EditorError::UnrepresentableFormat);
                }
                let old = body.before.start + definition.range.start - body.after.start;
                let row_index = self.rows.locate(old, false);
                let (row, base, _) = self.rows.at(row_index);
                let at = old - base;
                let mut literal = false;
                for segment in &row.segments {
                    work.items += 1;
                    literal |= segment.identity && segment.source.contains(&at);
                }
                for span in &row.spans {
                    work.items += 1;
                    if matches!(span.kind, super::super::row::SpanKind::Link(_))
                        && span.open.contains(&at)
                    {
                        literal = false;
                    }
                }
                for existing in &row.definitions {
                    work.items += 1;
                    if existing.range.contains(&at) {
                        literal = false;
                    }
                }
                if !literal || output.as_bytes().get(definition.range.start) != Some(&b'[') {
                    return Err(EditorError::UnrepresentableFormat);
                }
                openers.push(definition.range.start);
                break;
            }
        }
        if openers.is_empty() {
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
        work.items += actual_work.items + raw.len() * 2;
        work.copied += actual_work.copied;
        openers.retain(|opener| {
            actual.iter().any(|definition| {
                work.items += 1;
                definition.range.start == base + range.start + opener
            })
        });
        if openers.is_empty() {
            return Ok((work, copied));
        }
        // Canonical declaration traversal is source ordered. Earlier insertions
        // cannot move the remaining offsets when repairs run in reverse.
        for opener in openers.into_iter().rev() {
            copied += output.len() - opener;
            output.insert(opener, '\\');
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
        work.items += visits.items;
        work.copied += visits.copied;
        let checked =
            super::super::Projection::with_references(output, references, &winners, visits);
        work.parsed += checked.initial_parse_work;
        work.items += checked.initial_link_metadata_items;
        work.copied += checked.initial_link_copied_bytes;
        let old_start = self.display_at(range.start);
        let old_end = self.display_at(range.end);
        let old = self.display.byte_slice(old_start..old_end).to_string();
        let new = checked.display.to_string();
        copied += old.len() + new.len();
        work.items += old.len().min(new.len());
        if old != new {
            return Err(EditorError::UnrepresentableFormat);
        }
        // The unchanged visible body also preserves this slice's returned
        // display endpoints; source history is captured from the final edit.
        Ok((work, copied))
    }
}
