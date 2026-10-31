//! Retired Guard proof follows real copied atoms and opaque wiki emission.
use super::*;
use crate::inline::guarded_words::ValidationAtom;

impl Rewrite {
    pub fn guard_atoms(&self, fields: &mut Fields) -> Result<EditWork, EditorError> {
        let mut work = EditWork::default();
        for step in &self.steps {
            for atoms in &mut fields.guard_atoms {
                let Some(original) = atoms.take() else {
                    continue;
                };
                *atoms = step.guard_atoms(original, &mut work)?;
            }
        }
        Ok(work)
    }
}
impl WikiStep {
    fn guard_atoms(
        &self,
        atoms: Vec<ValidationAtom>,
        work: &mut EditWork,
    ) -> Result<Option<Vec<ValidationAtom>>, EditorError> {
        let mut output = Vec::new();
        let mut atoms = atoms.into_iter().peekable();
        while let Some(mut atom) = atoms.next() {
            work.link_metadata_items += 1;
            let (copied, visits) = self.copied.retained_range(atom.source.clone());
            work.link_metadata_items += visits;
            if let Some(source) = copied {
                atom.source = source;
                output.push(atom);
                work.link_metadata_items += 7;
                continue;
            }
            let index = self.replaced.partition_point(|part| {
                work.link_metadata_items += 1;
                part.range.before.end <= atom.source.start
            });
            let Some(replacement) = self.replaced.get(index) else {
                return Ok(None);
            };
            work.link_metadata_items += 3;
            // Only a complete original identity footprint inside retained
            // opaque Code can turn actual emitted bytes into semantic atoms.
            if atom.source.start != replacement.range.before.start || !atom.identity || !atom.code {
                return Ok(None);
            }
            let mut end = atom.source.end;
            while end < replacement.range.before.end {
                work.link_metadata_items += 1;
                let Some(next) = atoms.next() else {
                    return Ok(None);
                };
                if next.source.start != end || !next.identity || !next.code {
                    return Ok(None);
                }
                end = next.source.end;
            }
            if end != replacement.range.before.end {
                return Ok(None);
            }
            for (at, ch) in replacement.emitted.char_indices() {
                let displayed = ch.to_string();
                work.link_copied_bytes += displayed.len();
                output.push(ValidationAtom {
                    source: replacement.range.after.start + at
                        ..replacement.range.after.start + at + ch.len_utf8(),
                    displayed,
                    identity: true,
                    code: true,
                });
                work.link_metadata_items += 7;
            }
        }
        Ok(Some(output))
    }
}
