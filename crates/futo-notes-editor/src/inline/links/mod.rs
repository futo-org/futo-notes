//! Link source boundaries are owned here; destination interpretation comes from
//! the Markdown parser. Consumers receive destination semantics, never syntax.
use super::row::LinkMeaning;
mod angle;
mod bare;
mod edit;
mod insert;
pub(super) use angle::{complete_typed_angle, finish_angle_word};
pub(super) use bare::bare_links;
pub(in crate::inline) use edit::destination_source;

impl super::Projection {
    pub(crate) fn link_descriptions_with_work(
        &self,
        range: crate::DisplayRange,
    ) -> (
        Vec<crate::LinkDescription>,
        super::references::ReferenceWork,
    ) {
        let (runs, mut items) = self.row_link_runs(range);
        let mut active: Vec<(crate::DisplayRange, std::sync::Arc<LinkMeaning>)> = Vec::new();
        for (range, target) in runs {
            let (pending, visits) = self.link_is_pending_with_work(range);
            items += visits;
            if pending {
                continue;
            }
            if let Some((previous, meaning)) = active.last_mut() {
                items += 1;
                if previous.end == range.start
                    && (std::sync::Arc::ptr_eq(meaning, &target)
                        || meaning.destination == target.destination
                            && meaning.title == target.title)
                {
                    previous.end = range.end;
                    continue;
                }
            }
            active.push((range, target));
        }
        let mut work = super::references::ReferenceWork {
            parsed: 0,
            items,
            copied: 0,
        };
        let descriptions = active
            .into_iter()
            .filter(|(link, _)| link.start.0 <= range.end.0 && range.start.0 <= link.end.0)
            .map(|(range, target)| {
                work.items += 1;
                work.copied +=
                    target.destination.len() + target.title.as_ref().map_or(0, String::len);
                crate::LinkDescription {
                    range,
                    destination: target.destination.clone(),
                    title: target.title.clone(),
                }
            })
            .collect();
        (descriptions, work)
    }

    pub(super) fn all_link_ranges(
        &self,
        range: crate::DisplayRange,
    ) -> (Vec<crate::DisplayRange>, usize) {
        let (runs, work) = self.row_link_runs(range);
        (
            runs.into_iter()
                .map(|(range, _)| range)
                .filter(|link| link.start.0 <= range.end.0 && range.start.0 <= link.end.0)
                .collect(),
            work,
        )
    }

    fn row_link_runs(
        &self,
        range: crate::DisplayRange,
    ) -> (
        Vec<(crate::DisplayRange, std::sync::Arc<LinkMeaning>)>,
        usize,
    ) {
        let (first, a) = self.rows.locate_with_work(range.start.0, true);
        let (last, z) = self.rows.locate_with_work(range.end.0, true);
        let mut links = Vec::new();
        let mut work = a + z;
        for index in first..=last {
            let (row, _, display, nodes) = self.rows.at_with_work(index);
            work += nodes;
            for span in &row.spans {
                work += 1;
                if let super::row::SpanKind::Link(target) = &span.kind {
                    let (start, a) = row.display_at_with_work(span.open.end);
                    let (end, z) = row.display_at_with_work(span.close.start);
                    work += 1 + a + z;
                    links.push((
                        crate::DisplayRange {
                            start: crate::DisplayOffset(display + start),
                            end: crate::DisplayOffset(display + end),
                        },
                        target.clone(),
                    ));
                }
            }
        }
        (links, work)
    }
}
