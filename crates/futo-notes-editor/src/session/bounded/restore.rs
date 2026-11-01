use super::progress::{unit_display, unit_source};
use super::*;

impl BoundedEditorSession {
    pub(super) fn restore_unit(
        &mut self,
        previous: BoundedCursor,
        generation: u64,
        index: usize,
    ) -> Result<BoundedProgressChange, BoundedError> {
        let progress = self.progress.as_ref().unwrap();
        let unit = &progress.certificate.units[index];
        let last = index + 1 == progress.certificate.units.len();
        let source = unit_source(&self.engine.source, unit, last);
        let shown = unit_display(&self.display, unit, last, progress.frame_lines);
        let original_source = unit.source.clone();
        let original_display = unit.display.clone();
        let progress = self.progress.as_mut().unwrap();
        progress.code[index] = false;
        if progress.next == index {
            progress.next += 1;
        }
        Ok(self.install_retained_frame(
            previous,
            generation,
            shown,
            source,
            original_source,
            original_display,
            None,
            FrameKind::Region,
        ))
    }

    pub(super) fn install_retained_frame(
        &mut self,
        previous: BoundedCursor,
        generation: u64,
        range: DisplayRange,
        source: std::ops::Range<usize>,
        original_source: std::ops::Range<usize>,
        original_display: std::ops::Range<usize>,
        source_change: Option<BoundedSourceChange>,
        kind: FrameKind,
    ) -> BoundedProgressChange {
        let (projection, mut work) = self.engine.projection.bounded_retained_meaning(
            original_source,
            original_display,
            source.start,
            range.start.0,
            self.code.whole.start,
        );
        let old = self
            .display
            .byte_slice(range.start.0..range.end.0)
            .to_string();
        let same = old == projection.text;
        let a = self.display.byte_to_char(range.start.0);
        let z = self.display.byte_to_char(range.end.0);
        self.display.remove(a..z);
        self.display.insert(a, &projection.text);
        let inserted = if same {
            String::new()
        } else {
            projection.text.clone()
        };
        work.copied_bytes += old.len() + inserted.len();
        work.returned_text_bytes += inserted.len();
        if matches!(kind, FrameKind::Fence) {
            self.progress.as_mut().unwrap().frame_lines = 0;
        }
        work.metadata_items += self.reproject_code_selection();
        self.generation = generation;
        BoundedProgressChange {
            previous,
            cursor: self.cursor(),
            range: if same {
                DisplayRange {
                    start: range.start,
                    end: range.start,
                }
            } else {
                range
            },
            inserted,
            selection: self.engine.selection,
            affinity: self.engine.affinity,
            source_change,
            source_footprint: SourceRange {
                start: SourceOffset(source.start),
                end: SourceOffset(source.end),
            },
            projection,
            continuation: self.continuation(),
            work,
        }
    }
}
