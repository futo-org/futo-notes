//! The one place an input may repair a code block's frame.
use super::*;
use crate::inline::{Expected, Repair};

impl EditorSession {
    /// Runs one input on the note, `expected` saying what it shows. Only
    /// inside one may the planner give a code block's frame the end its cut
    /// dropped (`inline::Repair`); when it did, the edit the input then hands
    /// the host is first checked as a whole (`inline::keeps_blocks`). One that
    /// fails is not handed over: the input runs again without repairs, as it
    /// did before them. Inputs inside an input, or in a staged window, are its
    /// steps and run as they are.
    pub(super) fn checked_input<T>(
        &mut self,
        expected: Expected,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        mut run: impl FnMut(
            &mut Self,
            &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        ) -> Result<T, EditorError>,
    ) -> Result<T, EditorError> {
        if self.context.staged || !Repair::closed() {
            return run(self, accept);
        }
        let before = self.source.clone();
        let (mut handed, mut refused) = (0, false);
        let first = {
            let _open = Repair::open();
            run(self, &mut |edit| {
                handed += 1;
                if Repair::repaired() {
                    let old = before.to_string();
                    let mut new = old.clone();
                    new.replace_range(edit.range.start.0..edit.range.end.0, &edit.inserted);
                    if handed > 1 || !crate::inline::keeps_blocks(&old, &new, &expected) {
                        refused = true;
                        return Err("not as shown".into());
                    }
                }
                accept(edit)
            })
        };
        if !refused {
            return first;
        }
        let _barred = Repair::bar();
        run(self, accept)
    }
}
