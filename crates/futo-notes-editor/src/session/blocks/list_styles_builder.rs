//! Command-local owner fragments, planned neighbors and independent marker decisions.
use super::*;

struct Fragment {
    selection: std::ops::Range<usize>,
    owner: Option<std::ops::Range<usize>>,
    quote_depth: usize,
    depth: usize,
    owner_run: Option<usize>,
    cached: Option<OwnerStyle>,
    after_line: usize,
}
struct MarkerChoice {
    before: Option<u8>,
    after: Option<u8>,
    after_at: usize,
    join: Option<u8>,
    marker: u8,
    retained_ordered: bool,
}
struct StylePlanner<'a> {
    session: &'a EditorSession,
    lines: &'a [ListCommandLine],
    command: BlockCommand,
    intent: ListIntent,
    targets: Option<&'a ListTargets>,
    ordered: bool,
    planned_owners: HashSet<usize>,
    resolved_owners: HashMap<usize, Vec<OwnerStyle>>,
    resolved_lines: HashMap<usize, (u8, usize, usize)>,
    owner_ordinals: HashMap<usize, u64>,
    result: ListStylePlan,
}

pub(super) fn build(
    session: &EditorSession,
    lines: &[ListCommandLine],
    command: BlockCommand,
    intent: ListIntent,
    targets: Option<&ListTargets>,
) -> ListStylePlan {
    let ordered = command == BlockCommand::OrderedList;
    let candidates: &[u8] = if ordered { b".)" } else { b"-+*" };
    let planned_owners: HashSet<_> = lines
        .iter()
        .filter(|line| targets.is_none_or(|targets| !targets.removes(line)))
        .filter_map(|line| line.list.as_ref().map(|list| list.owner.start))
        .collect();
    let resolved_owners: HashMap<usize, Vec<OwnerStyle>> = HashMap::new();
    let resolved_lines = HashMap::new();
    let owner_ordinals: HashMap<usize, u64> = HashMap::new();
    let result = ListStylePlan {
        markers: vec![candidates[0]; lines.len()],
        ordinals: vec![1; lines.len()],
        quotes: lines
            .iter()
            .map(|line| {
                crate::inline::visit_container();
                if matches!(intent, ListIntent::Independent)
                    && line.list.is_none()
                    && line.heading == 0
                {
                    0
                } else {
                    line.quote_depth
                }
            })
            .collect(),
        comments: Vec::new(),
        materialized: 0,
    };
    let mut planner = StylePlanner {
        session,
        lines,
        command,
        intent,
        targets,
        ordered,
        planned_owners,
        resolved_owners,
        resolved_lines,
        owner_ordinals,
        result,
    };
    let mut first = 0;
    while first < lines.len() {
        if planner.skip_retired(first) {
            first += 1;
            continue;
        }
        let fragment = planner.fragment(first);
        let choice = planner.choose_marker(&fragment);
        planner.record(&fragment, &choice);
        planner.boundary_comment(&fragment, &choice);
        first = fragment.selection.end;
    }
    planner.result
}

impl StylePlanner<'_> {
    fn skip_retired(&mut self, first: usize) -> bool {
        if self
            .targets
            .is_some_and(|targets| targets.removes(&self.lines[first]))
        {
            // A retired item is a paragraph barrier. A later fragment of
            // this original owner starts its own ordered sequence.
            if let Some(list) = &self.lines[first].list {
                crate::inline::visit_container();
                self.owner_ordinals.remove(&list.owner.start);
            }
            return true;
        }
        false
    }

    fn fragment(&self, first: usize) -> Fragment {
        let (lines, command, targets) = (self.lines, self.command, self.targets);
        let (result, resolved_owners, intent) = (&self.result, &self.resolved_owners, &self.intent);
        let owner = lines[first].list.as_ref().map(|list| list.owner.clone());
        let mut last = first + 1;
        while last < lines.len()
            && targets.is_none_or(|targets| !targets.removes(&lines[last]))
            && lines[last].list.as_ref().map(|list| list.owner.clone()) == owner
            && (owner.is_some()
                || targets
                    .is_none_or(|targets| targets.run(&lines[first]) == targets.run(&lines[last])))
        {
            last += 1;
        }
        let head = &lines[first];
        let quote_depth = result.quotes[first];
        let tail = &lines[last - 1];
        let depth = head.list.as_ref().map_or(1, |list| {
            targets.map_or(list.depth, |targets| targets.output_depth(list))
        });
        let owner_run =
            targets.and_then(|targets| head.list.as_ref().and_then(|list| targets.owner_run(list)));
        let cached = owner
            .as_ref()
            .and_then(|owner| {
                crate::inline::visit_container();
                resolved_owners
                    .get(&owner.start)
                    .and_then(|fragments| fragments.last())
            })
            .filter(|style| {
                style.start <= head.source.start
                    && tail.source.start < style.end
                    && style.quote == quote_depth
                    && style.depth == depth
                    && style.kind == command
                    && style.run == owner_run
                    && matches!(intent, ListIntent::Independent)
            })
            .map(|style| {
                crate::inline::visit_container();
                *style
            });
        let after_line = self.fragment_after_line(head, tail, &owner, depth, cached);
        Fragment {
            selection: first..last,
            owner,
            quote_depth,
            depth,
            owner_run,
            cached,
            after_line,
        }
    }

    fn fragment_after_line(
        &self,
        head: &ListCommandLine,
        tail: &ListCommandLine,
        owner: &Option<std::ops::Range<usize>>,
        depth: usize,
        cached: Option<OwnerStyle>,
    ) -> usize {
        let (session, targets) = (self.session, self.targets);
        let before_line = session.source.byte_to_line(head.source.start);
        // Container event endpoints can include a following quote prefix.
        // Walk actual physical item ownership instead of skipping that line.
        let mut after_line = session
            .source
            .byte_to_line(tail.source.end.saturating_sub(1))
            + 1;
        if let Some(style) = cached {
            after_line = style.after_line;
        } else if let Some(owner) = owner {
            let mut scan = after_line;
            while scan < session.source.len_lines() {
                #[cfg(test)]
                crate::inline::CONTAINER_STYLE_OWNER_SCANS.with(|count| count.set(count.get() + 1));
                let at = session.source.line_to_byte(scan);
                let Some(line) = session.projection.list_command_line_at_source(at) else {
                    break;
                };
                // An exact retired item becomes a paragraph outside this
                // list. It ends the current owner fragment immediately.
                if targets
                    .is_some_and(|targets| targets.retires(line.source.start, line.list.as_ref()))
                {
                    break;
                }
                let belongs = line.list.as_ref().is_some_and(|list| {
                    list.owner == *owner
                        || list.depth > depth
                            && owner.start <= list.marker.start
                            && list.marker.start < owner.end
                });
                if !belongs {
                    break;
                }
                scan += 1;
                let blank = session
                    .source
                    .byte_slice(line.content.clone())
                    .chars()
                    .all(|ch| matches!(ch, ' ' | '\t'));
                if !blank || line.list.as_ref().is_some_and(|list| list.first) {
                    after_line = scan;
                }
            }
        }
        while cached.is_none() && after_line > before_line + 1 {
            let at = session.source.line_to_byte(after_line - 1);
            let Some(line) = session.projection.list_command_line_at_source(at) else {
                break;
            };
            let blank = session
                .source
                .byte_slice(line.content.clone())
                .chars()
                .all(|ch| matches!(ch, ' ' | '\t'));
            if !blank
                || line.empty_comment
                || line.quote_depth != head.quote_depth
                || line.list.as_ref().is_some_and(|list| list.first)
            {
                break;
            }
            after_line -= 1;
        }
        after_line
    }

    fn neighbor(&self, at: usize, forward: bool, fragment: &Fragment) -> Option<(u8, Option<u64>)> {
        let (quote_depth, depth) = (fragment.quote_depth, fragment.depth);
        let (targets, command, ordered) = (self.targets, self.command, self.ordered);
        let (resolved_lines, resolved_owners, planned_owners) = (
            &self.resolved_lines,
            &self.resolved_owners,
            &self.planned_owners,
        );
        let neighbor = self.session.semantic_neighbor(at, forward, quote_depth)?;
        let line = neighbor.witness;
        if line.empty_comment || line.code {
            return None;
        }
        if neighbor.local
            && targets.is_some_and(|targets| targets.retires(line.source.start, line.list.as_ref()))
        {
            return None;
        }
        // A planned local paragraph may now be a root list. Resolve its
        // explicit outcome before consulting its original quote scope.
        if neighbor.local && line.list.is_none() {
            if let Some(&(marker, quote, nested)) = resolved_lines.get(&line.source.start) {
                return (quote == quote_depth && nested == depth).then_some((marker, None));
            }
        }
        if line.quote_depth != quote_depth {
            return None;
        }
        if let Some(list) = &line.list {
            crate::inline::visit_container();
            let resolved = resolved_owners
                .get(&list.owner.start)
                .filter(|_| neighbor.local)
                .and_then(|fragments| {
                    let end = fragments.partition_point(|style| {
                        crate::inline::visit_container();
                        style.start <= line.source.start
                    });
                    end.checked_sub(1).and_then(|index| fragments.get(index))
                })
                .filter(|style| {
                    line.source.start < style.end
                        && style.kind == command
                        && style.run == targets.and_then(|targets| targets.owner_run(list))
                });
            if let Some(style) = resolved {
                return (style.quote == quote_depth && style.depth == depth)
                    .then_some((style.marker, None));
            }
            if neighbor.local && planned_owners.contains(&list.owner.start) {
                return None;
            }
            if list.depth != depth {
                return None;
            }
            if list.ordinal.is_some() == ordered {
                return Some((
                    neighbor.marker.unwrap(),
                    list.ordinal.map(|number| number + 1),
                ));
            }
        }
        None
    }

    fn choose_marker(&self, fragment: &Fragment) -> MarkerChoice {
        let head = &self.lines[fragment.selection.start];
        let (cached, after_line) = (fragment.cached, fragment.after_line);
        let (ordered, intent) = (self.ordered, &self.intent);
        let preceding = cached
            .is_none()
            .then(|| self.neighbor(head.source.start, false, fragment))
            .flatten();
        let before = preceding.map(|(marker, _)| marker);
        let after_at = cached.map_or_else(
            || {
                if after_line < self.session.source.len_lines() {
                    self.session.source.line_to_byte(after_line)
                } else {
                    self.session.source.len_bytes()
                }
            },
            |style| style.end,
        );
        let after = cached
            .is_none()
            .then(|| self.neighbor(after_at, true, fragment))
            .flatten()
            .map(|(marker, _)| marker);
        // Shipping wrappingInputRule joins only the preceding list. Ordered
        // input must spell its interpreted next number; bullets always join.
        let join = match self.intent {
            ListIntent::Shortcut { start } => preceding
                .filter(|(_, next)| start == *next)
                .map(|(marker, _)| marker),
            ListIntent::Independent => None,
        };
        // Removing task state from an already ordered owner preserves
        // that owner's start and delimiter; it does not wrap a new list.
        let retained_ordered = ordered
            && matches!(intent, ListIntent::Independent)
            && head
                .list
                .as_ref()
                .is_some_and(|list| list.ordinal.is_some());
        let marker = cached.map_or_else(
            || {
                if retained_ordered {
                    crate::inline::visit_container();
                    self.session
                        .source
                        .byte(head.list.as_ref().unwrap().marker.end - 1)
                } else {
                    join.unwrap_or_else(|| independent_marker(ordered, before, after))
                }
            },
            |style| style.marker,
        );
        MarkerChoice {
            before,
            after,
            after_at,
            join,
            marker,
            retained_ordered,
        }
    }

    fn record(&mut self, fragment: &Fragment, choice: &MarkerChoice) {
        let (first, last) = (fragment.selection.start, fragment.selection.end);
        let (owner, cached) = (&fragment.owner, fragment.cached);
        let (quote_depth, depth, owner_run) =
            (fragment.quote_depth, fragment.depth, fragment.owner_run);
        let (marker, after_at, after_line, retained_ordered) = (
            choice.marker,
            choice.after_at,
            fragment.after_line,
            choice.retained_ordered,
        );
        let (lines, command) = (self.lines, self.command);
        let head = &lines[first];
        for (offset, line) in lines[first..last].iter().enumerate() {
            let index = first + offset;
            crate::inline::visit_container();
            self.result.markers[index] = marker;
            self.result.ordinals[index] = if retained_ordered {
                line.list.as_ref().unwrap().ordinal.unwrap()
            } else if let Some(owner) = &owner {
                // Nested owners can intervene in physical source order;
                // they must not restart their enclosing owner's sequence.
                crate::inline::visit_container();
                let ordinal = self.owner_ordinals.entry(owner.start).or_default();
                *ordinal += 1;
                *ordinal
            } else {
                (index - first) as u64 + 1
            };
            self.resolved_lines.insert(
                line.source.start,
                (marker, self.result.quotes[index], depth),
            );
        }
        if let Some(owner) = owner.as_ref().filter(|_| cached.is_none()) {
            crate::inline::visit_container();
            self.resolved_owners
                .entry(owner.start)
                .or_default()
                .push(OwnerStyle {
                    marker,
                    quote: quote_depth,
                    depth,
                    kind: command,
                    run: owner_run,
                    start: head.source.start,
                    end: after_at,
                    after_line,
                });
        }
    }

    fn boundary_comment(&mut self, fragment: &Fragment, choice: &MarkerChoice) {
        let session = self.session;
        let head = &self.lines[fragment.selection.start];
        let (before, after, marker, join) =
            (choice.before, choice.after, choice.marker, choice.join);
        let (quote_depth, after_line) = (fragment.quote_depth, fragment.after_line);
        if before == Some(marker) && join.is_none() || after == Some(marker) {
            let prefix = session
                .source
                .byte_slice(head.source.start..head.content.start)
                .to_string();
            let retained = if let Some(list) = &head.list {
                list.marker.start - head.source.start
            } else {
                super::indent_source::canonical_quote_end(&prefix, quote_depth).unwrap_or(0)
            };
            let comment = format!("{}<!-- -->\n", &prefix[..retained]);
            self.result.materialized += prefix.len() + comment.len();
            if before == Some(marker) && join.is_none() {
                self.result.comments.push((head.source.start, comment));
            } else if after == Some(marker) {
                let at = if after_line < session.source.len_lines() {
                    session.source.line_to_byte(after_line)
                } else {
                    session.source.len_bytes()
                };
                self.result.comments.push((at, comment));
            }
        }
    }
}
