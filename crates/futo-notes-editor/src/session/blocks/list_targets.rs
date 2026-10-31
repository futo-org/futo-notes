//! Per-run list intent uses only canonical ranges/scalars, never body vectors.
use super::*;
use crate::inline::{blocks::ListCommandLine, ListLine};
use std::{collections::HashMap, ops::Range};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Format {
    Code,
    Bullet,
    Ordered,
    Task,
    Heading(u8),
    Quote,
    Plain,
}

impl Format {
    fn at(line: &ListCommandLine) -> Self {
        crate::inline::visit_container();
        if line.code {
            Self::Code
        } else if let Some(list) = &line.list {
            if list.checked.is_some() {
                Self::Task
            } else if list.ordinal.is_some() {
                Self::Ordered
            } else {
                Self::Bullet
            }
        } else if line.heading > 0 {
            Self::Heading(line.heading)
        } else if line.quote_depth > 0 {
            Self::Quote
        } else {
            Self::Plain
        }
    }

    fn removes(self, command: BlockCommand) -> bool {
        command == BlockCommand::Heading(0)
            || matches!(
                (self, command),
                (Self::Bullet, BlockCommand::BulletList)
                    | (Self::Ordered, BlockCommand::OrderedList)
                    | (Self::Task, BlockCommand::TaskList)
            )
    }
}

pub(super) struct ListTargets {
    selected: HashMap<usize, (usize, bool)>,
    retired: HashMap<usize, (Range<usize>, usize)>,
    owners: HashMap<usize, (Range<usize>, usize)>,
    pub covered_descendants: bool,
    retired_depths: Vec<(usize, usize)>,
}

impl ListTargets {
    pub fn new(lines: &[ListCommandLine], command: BlockCommand, full_ancestry: bool) -> Self {
        let mut result = Self {
            selected: HashMap::new(),
            retired: HashMap::new(),
            owners: HashMap::new(),
            covered_descendants: false,
            retired_depths: Vec::new(),
        };
        let written = lines.iter().any(|line| {
            crate::inline::visit_container();
            !line.content.is_empty()
                || line.heading > 0
                || line.list.as_ref().is_some_and(|list| list.first)
        });
        let mut previous = None;
        let mut run = 0;
        let mut ancestor: Option<(Range<usize>, usize, usize)> = None;
        for line in lines {
            crate::inline::visit_container();
            if line.divider {
                continue;
            }
            if written
                && !line.code
                && line.content.is_empty()
                && line.heading == 0
                && line.list.is_none()
                && line.quote_depth == 0
            {
                continue;
            }
            let format = Format::at(line);
            if previous.is_some_and(|previous| previous != format) {
                run += 1;
            }
            previous = Some(format);
            if line.code {
                continue;
            }
            let remove = format.removes(command);
            if let Some(list) = &line.list {
                if remove {
                    if full_ancestry
                        && ancestor.as_ref().is_some_and(|(item, depth, owner_run)| {
                            crate::inline::visit_container();
                            *owner_run == run
                                && *depth < list.depth
                                && item.start <= list.marker.start
                                && list.marker.start < item.end
                        })
                    {
                        result.covered_descendants = true;
                        continue;
                    }
                    crate::inline::visit_container();
                    result
                        .retired
                        .entry(list.marker.start)
                        .or_insert((list.item.clone(), run));
                    ancestor = Some((list.item.clone(), list.depth, run));
                } else {
                    crate::inline::visit_container();
                    result
                        .owners
                        .entry(list.owner.start)
                        .or_insert((list.owner.clone(), run));
                }
            }
            crate::inline::visit_container();
            result.selected.insert(line.source.start, (run, remove));
        }
        // A source-position index describes only the command's retired item
        // intervals. It is not retained ancestry or a second parser model.
        let mut events = Vec::new();
        for (&marker, (item, _)) in &result.retired {
            crate::inline::visit_container();
            events.push((marker + 1, 1isize));
            events.push((item.end, -1));
        }
        events.sort_by_key(|event| {
            crate::inline::visit_container();
            event.0
        });
        let mut active = 0isize;
        for (at, delta) in events {
            crate::inline::visit_container();
            active += delta;
            result.retired_depths.push((at, active as usize));
        }
        result
    }

    pub fn output_depth(&self, list: &ListLine) -> usize {
        let end = self.retired_depths.partition_point(|&(at, _)| {
            crate::inline::visit_container();
            at <= list.marker.start
        });
        let retired = end
            .checked_sub(1)
            .map_or(0, |index| self.retired_depths[index].1);
        list.depth.saturating_sub(retired).max(1)
    }

    pub fn retired_items(&self) -> impl Iterator<Item = &Range<usize>> {
        self.retired.values().map(|(range, _)| {
            crate::inline::visit_container();
            range
        })
    }

    pub fn changed_owners(&self) -> impl Iterator<Item = &Range<usize>> {
        self.owners.values().map(|(range, _)| {
            crate::inline::visit_container();
            range
        })
    }

    pub fn retires_item(&self, list: &ListLine) -> bool {
        crate::inline::visit_container();
        self.retired.contains_key(&list.marker.start)
    }

    pub fn retires(&self, source: usize, list: Option<&ListLine>) -> bool {
        if let Some(list) = list {
            if self.retires_item(list) {
                return true;
            }
        }
        crate::inline::visit_container();
        self.selected
            .get(&source)
            .is_some_and(|(_, remove)| *remove)
    }

    pub fn removes(&self, line: &ListCommandLine) -> bool {
        self.retires(line.source.start, line.list.as_ref())
    }

    pub fn applies(&self, line: &ListCommandLine) -> bool {
        crate::inline::visit_container();
        if line.code || line.divider {
            return false;
        }
        if self.removes(line) {
            return true;
        }
        if let Some(list) = &line.list {
            crate::inline::visit_container();
            list.first
                && (self.selected.contains_key(&line.source.start)
                    || self.owners.contains_key(&list.owner.start))
        } else {
            crate::inline::visit_container();
            self.selected.contains_key(&line.source.start)
        }
    }

    /// The first run retargets the entire canonical owner, including headers
    /// separated by unrelated nested runs. Plain/quote runs remain per-line.
    pub fn owner_run(&self, list: &ListLine) -> Option<usize> {
        crate::inline::visit_container();
        self.owners.get(&list.owner.start).map(|(_, run)| *run)
    }

    pub fn run(&self, line: &ListCommandLine) -> Option<usize> {
        crate::inline::visit_container();
        if let Some((run, _)) = self.selected.get(&line.source.start) {
            return Some(*run);
        }
        let list = line.list.as_ref()?;
        crate::inline::visit_container();
        if let Some((_, run)) = self.retired.get(&list.marker.start) {
            return Some(*run);
        }
        crate::inline::visit_container();
        self.owners.get(&list.owner.start).map(|(_, run)| *run)
    }
}
