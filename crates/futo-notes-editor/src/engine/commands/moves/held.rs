//! Which lines a list holds, for the landing rule that only an item or one
//! plain line lands strictly between two lines of a list. A line belongs to
//! a list when it is an unquoted item, or an unquoted item holds it as
//! Indent moves it (`list_subtree_end`); the reader carries the items that
//! hold the next line (`Carry::holders`), so each line is answered alone.
use crate::engine::Engine;
use crate::lines::{FenceRole, Kind};

impl Engine {
    /// Whether boundary `at` is strictly inside a list: a list holds the
    /// lines on both sides of it.
    pub(super) fn inside_list(&self, at: usize) -> bool {
        0 < at && at < self.line_count() && self.held(at) && self.held(at - 1)
    }

    /// Whether a list holds line `index`.
    pub(super) fn held(&self, index: usize) -> bool {
        let entry = self.line(index);
        let (line, carry) = (&entry.line, &entry.carry);
        match line.kind {
            Kind::Fence {
                role: FenceRole::Code | FenceRole::Close,
                ..
            } => carry.held_fence,
            _ if line.quote > 0 => false,
            Kind::List { .. } => true,
            Kind::Plain { indent }
            | Kind::Fence {
                role: FenceRole::Open,
                indent,
                ..
            } => carry.holders.first().is_some_and(|&outer| outer < indent),
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::engine::Engine;
    use crate::lines::Kind;

    /// The lines a list holds as Indent reads them: from the top, each
    /// unquoted item not already held starts a list through the lines it
    /// moves with (`list_subtree_end`).
    fn held_by_indent(engine: &Engine) -> Vec<bool> {
        let mut end = 0;
        (0..engine.line_count())
            .map(|at| {
                let line = &engine.line(at).line;
                if at >= end && line.quote == 0 && matches!(line.kind, Kind::List { .. }) {
                    end = engine.list_subtree_end(at);
                }
                at < end
            })
            .collect()
    }

    #[test]
    fn a_line_is_held_exactly_where_indent_moves_it_with_an_item() {
        const LINES: &[&str] = &[
            "- a", "  - b", "    - c", "  x", "    y", " z", "w", "", "  ", "> q", "> - r",
            "  ```", "```", "code", "  code", "# h", "| t |", "|---|", "1. n", "- [ ] t", "---",
        ];
        let mut seed: u64 = 0x5eed_446;
        for _ in 0..3000 {
            let mut next = |below: usize| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                (seed % below as u64) as usize
            };
            let count = 1 + next(14);
            let note: Vec<_> = (0..count).map(|_| LINES[next(LINES.len())]).collect();
            let engine = Engine::open(&note.join("\n"));
            let held: Vec<_> = (0..engine.line_count()).map(|at| engine.held(at)).collect();
            assert_eq!(held, held_by_indent(&engine), "{note:?}");
        }
    }
}
