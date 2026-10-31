//! Validate header-lift endpoints in one actual-row preview before acceptance.
use super::*;
use std::ops::Range;

impl EditorSession {
    pub(in crate::session::blocks) fn preview_header_selection(
        &self,
        range: DisplayRange,
        footprint: Range<usize>,
        edits: &[(Range<usize>, String)],
        output: &str,
    ) -> Result<(DisplayRange, usize, usize), EditorError> {
        let points = [
            self.projection.retained_point(range.start.0)?,
            self.projection.retained_point(range.end.0)?,
        ];
        let mut bounds = footprint.clone();
        for point in points {
            crate::inline::visit_container();
            let extent = point.extent();
            bounds.start = bounds.start.min(extent.start);
            bounds.end = bounds.end.max(extent.end);
        }
        let (window, display) = self.projection.retained_point_window(bounds);
        let raw = self.source.byte_slice(window.clone()).to_string();
        let mut preview = self.stage_source(&raw, window.clone());
        let edit = preview.prepare_source(
            preview.revision(),
            SourceRange {
                start: SourceOffset(footprint.start - window.start),
                end: SourceOffset(footprint.end - window.start),
            },
            output,
        )?;
        // This private apply calls no host, clock or history operation.
        let work = preview.apply(&edit).work;
        let mut mapped = [0; 2];
        for (index, point) in points.into_iter().enumerate() {
            let shifted = point
                .through_edits(footprint.start, edits)?
                .relative(window.start)?;
            point.verify_raw(&self.source, shifted, &preview.source)?;
            mapped[index] = display + preview.projection.project_retained_point(shifted)?;
        }
        Ok((
            DisplayRange {
                start: DisplayOffset(mapped[0]),
                end: DisplayOffset(mapped[1]),
            },
            2 * raw.len() + work.parsed_source_bytes,
            raw.len() + output.len() + work.materialized_source_bytes,
        ))
    }
}

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn header_atom_preview_excludes_unrelated_rows_and_counts_real_source_work() {
        let mut measured = Vec::new();
        for count in [1, 20_000] {
            let prefix = "foreign\n\n".repeat(count);
            let raw = format!("{prefix}- > &acE;");
            let expected = format!("{prefix}\n> &acE;");
            let before = format!("{prefix}\u{223e}\u{0333}");
            let shown = format!("{prefix}\n\u{223e}\u{0333}");
            let mut s = EditorSession::open(&raw);
            assert_eq!(s.display_text(), before);
            let selected = DisplayRange {
                start: DisplayOffset(prefix.len() + 3),
                end: DisplayOffset(prefix.len() + 3),
            };
            s.select_with_affinity(Revision(0), selected, Affinity::Backward)
                .unwrap();
            crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.set(0));
            let mut accepted = 0;
            let change = s
                .block_command(
                    Revision(0),
                    selected,
                    BlockCommand::Heading(0),
                    &mut |edit| {
                        accepted += 1;
                        assert!(edit.range.start.0 >= prefix.len());
                        Ok(())
                    },
                )
                .unwrap()
                .unwrap();
            let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.get());
            let mut view = before.clone();
            view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(accepted, 1);
            assert_eq!(view, shown);
            assert_eq!(s.source_text(), expected);
            assert_eq!(
                s.selection(),
                DisplayRange {
                    start: DisplayOffset(prefix.len() + 4),
                    end: DisplayOffset(prefix.len() + 4),
                }
            );
            assert!(visits > 0 && visits < 4096, "metadata={visits}");
            assert!(
                change.work.parsed_source_bytes > 0 && change.work.parsed_source_bytes < 4096,
                "parsed={}",
                change.work.parsed_source_bytes
            );
            assert!(
                change.work.materialized_source_bytes > 0
                    && change.work.materialized_source_bytes < 4096,
                "copied={}",
                change.work.materialized_source_bytes
            );
            measured.push((
                change.work.parsed_source_bytes,
                change.work.materialized_source_bytes,
            ));
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), Affinity::Backward);
        }
        assert_eq!(measured[0], measured[1]);
    }

    #[test]
    fn one_header_preview_uses_bounded_passes_over_its_actual_large_list_row() {
        let mut measured = Vec::new();
        for count in [64, 512] {
            let tail = (0..count)
                .map(|i| format!("- p{i}"))
                .collect::<Vec<_>>()
                .join("\n");
            let tail_view = (0..count)
                .map(|i| format!("p{i}"))
                .collect::<Vec<_>>()
                .join("\n");
            let raw = format!("- > &acE;\n{tail}");
            let expected = format!("\n> &acE;\n{tail}");
            let before = format!("\u{223e}\u{0333}\n{tail_view}");
            let shown = format!("\n{before}");
            assert_eq!(EditorSession::open(&expected).display_text(), shown);
            let mut s = EditorSession::open(&raw);
            assert_eq!(s.display_text(), before);
            let selected = DisplayRange {
                start: DisplayOffset(3),
                end: DisplayOffset(3),
            };
            s.select_with_affinity(Revision(0), selected, Affinity::Backward)
                .unwrap();
            crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.set(0));
            let mut accepted = 0;
            let change = s
                .block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap()
                .unwrap();
            let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.get());
            let mut view = before.clone();
            view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(accepted, 1);
            assert_eq!(view, shown);
            assert_eq!(s.source_text(), expected);
            assert_eq!(
                s.selection(),
                DisplayRange {
                    start: DisplayOffset(4),
                    end: DisplayOffset(4)
                }
            );
            let p = s
                .project(
                    s.revision(),
                    DisplayRange {
                        start: DisplayOffset(0),
                        end: DisplayOffset(shown.len()),
                    },
                )
                .unwrap();
            assert_eq!(
                p.blocks
                    .iter()
                    .filter_map(|b| b.list.as_ref().filter(|l| l.first))
                    .count(),
                count
            );
            assert!(
                visits > 0 && visits < 128 * raw.len(),
                "count={count} metadata={visits}"
            );
            assert!(
                change.work.parsed_source_bytes < 32 * raw.len(),
                "count={count} parsed={}",
                change.work.parsed_source_bytes
            );
            assert!(
                change.work.materialized_source_bytes < 32 * raw.len(),
                "count={count} copied={}",
                change.work.materialized_source_bytes
            );
            measured.push((raw.len(), visits));
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), Affinity::Backward);
        }
        let (a_bytes, a) = measured[0];
        let (b_bytes, b) = measured[1];
        assert!(
            (b as u128) * (a_bytes as u128) < 2 * (a as u128) * (b_bytes as u128),
            "header row input={a_bytes}..{b_bytes} metadata={a}..{b}"
        );
    }
}
