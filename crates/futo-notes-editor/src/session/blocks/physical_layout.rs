//! Complete staged source ranges in the actual emitted physical layout.
pub(super) struct SplitLayout<'a> {
    pub(super) left: &'a super::content::PhysicalBody,
    pub(super) right: &'a super::content::PhysicalBody,
    pub(super) prefix: usize,
    pub(super) right_start: usize,
    pub(super) break_start: usize,
    pub(super) heading_end: usize,
    pub(super) split: usize,
    pub(super) unchanged_left: bool,
    pub(super) unchanged_right: bool,
    pub(super) setext: bool,
}
impl SplitLayout<'_> {
    pub(super) fn guard_atoms(
        &self,
        mut atoms: Vec<crate::inline::guarded_words::ValidationAtom>,
        base: usize,
    ) -> Result<(Vec<crate::inline::guarded_words::ValidationAtom>, usize), crate::EditorError>
    {
        let mut work = 0;
        for atom in &mut atoms {
            let (after, visits) = self.retained_range(atom.source.clone());
            let after = after.ok_or(crate::EditorError::UnrepresentableFormat)?;
            work += visits + 2;
            atom.source = base + after.start..base + after.end;
        }
        Ok((atoms, work))
    }

    pub(super) fn retained_range(
        &self,
        range: std::ops::Range<usize>,
    ) -> (Option<std::ops::Range<usize>>, usize) {
        if self.unchanged_left && range.end <= self.heading_end {
            let (mapped, work) = self.left.retained_range(range);
            (
                mapped.map(|r| self.prefix + r.start..self.prefix + r.end),
                work + 1,
            )
        } else if self.setext && range.start >= self.heading_end && range.end <= self.split {
            (
                Some(
                    self.break_start + range.start - self.heading_end
                        ..self.break_start + range.end - self.heading_end,
                ),
                1,
            )
        } else if self.unchanged_right && range.start >= self.split + 2 {
            let local = range.start - self.split - 2..range.end - self.split - 2;
            let (mapped, work) = self.right.retained_range(local);
            (
                mapped.map(|r| self.right_start + r.start..self.right_start + r.end),
                work + 1,
            )
        } else {
            (None, 1)
        }
    }
}

/// Validate an already-owned current body against its protected output. Byte
/// equality verifies that copied part; it never discovers source identity.
pub(super) fn same_source(before: &str, after: &str, work: &mut usize) -> bool {
    *work += 1;
    before.len() == after.len()
        && before.bytes().zip(after.bytes()).all(|(a, b)| {
            *work += 1;
            a == b
        })
}
