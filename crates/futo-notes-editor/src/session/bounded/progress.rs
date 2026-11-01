use super::*;
use crate::inline::bounded::{FenceSuffix, ParagraphUnit};

pub(super) struct ProgressState {
    pub(super) certificate: FenceSuffix,
    pub(super) code: Vec<bool>,
    pub(super) active: bool,
    pub(super) next: usize,
    pub(super) id: u64,
    pub(super) frame_lines: usize,
    pub(super) changed: bool,
    pub(super) restore: bool,
}

impl ProgressState {
    pub(super) fn prepare(
        engine: &EditorSession,
        code: &crate::inline::bounded::RetainedCode,
    ) -> (Option<Self>, BoundedWork) {
        let (certificate, mut work) = engine.projection.bounded_fence_suffix(&engine.source, code);
        let prepared = certificate.map(|certificate| {
            work.metadata_items += certificate.units.len();
            Self {
                code: vec![false; certificate.units.len()],
                certificate,
                active: false,
                next: 0,
                id: 0,
                frame_lines: 0,
                changed: false,
                restore: false,
            }
        });
        (prepared, work)
    }

    pub(super) fn accepted_input(&mut self) {
        if self.active {
            self.id += 1;
        }
    }
}

impl BoundedEditorSession {
    pub fn continuation(&self) -> Option<ProjectionContinuation> {
        let progress = self.progress.as_ref()?;
        progress.active.then(|| ProjectionContinuation {
            id: progress.id,
            cursor: self.cursor(),
        })
    }

    pub fn remove_fence_closer(
        &mut self,
        cursor: BoundedCursor,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<BoundedProgressChange, BoundedError> {
        if cursor != self.cursor() {
            return Err(BoundedError::StaleCursor);
        }
        let progress = self.progress.as_ref().ok_or(BoundedError::Unsupported)?;
        if self.engine.selection.start != self.engine.selection.end
            || self.engine.selection.start.0 < self.code.display.start
            || self.engine.selection.end.0 > self.code.display.end
        {
            return Err(BoundedError::Unsupported);
        }
        if progress.changed {
            return Err(BoundedError::Unsupported);
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(BoundedError::Editor(EditorError::RevisionExhausted))?;
        let body_growth = self.code.body.end - progress.certificate.frame_source.start;
        let closer = progress.certificate.closer.start + body_growth
            ..progress.certificate.closer.end + body_growth;
        let edit = self
            .engine
            .prepare_source(
                cursor.revision,
                SourceRange {
                    start: SourceOffset(closer.start),
                    end: SourceOffset(closer.end),
                },
                "",
            )
            .map_err(BoundedError::Editor)?;
        let first = &progress.certificate.units[0];
        let display_end = self.display.line_to_byte(first.display_lines.start);
        let display_range = DisplayRange {
            start: DisplayOffset(self.code.display.end),
            end: DisplayOffset(display_end),
        };
        let before_selection = self.engine.selection;
        let before_formats = self.engine.pending_formats.clone();
        let before_affinity = self.engine.affinity;
        let before_links = opaque_pending(self.code.whole.clone());
        let prepared = self.prepare_page_source(&edit, SourceRegion::Closer(true), None)?;
        accept(&edit).map_err(|error| BoundedError::Editor(EditorError::Persistence(error)))?;
        let source_work = self.accept_page_source(&edit, SourceRegion::Closer(true), prepared);
        self.engine.typing = None;
        self.engine.pending_formats = None;
        self.discard_redo();
        let source_change = BoundedSourceChange {
            range: edit.range,
            inserted_bytes: 0,
        };
        let history = HistoryEntry {
            before_source: self.history_selection,
            after_source: self.history_selection,
            before_selection,
            before_affinity,
            before_formats,
            before_links,
            after_selection: before_selection,
            after_affinity: before_affinity,
            after_formats: None,
            after_links: opaque_pending(self.code.whole.start..self.engine.source.len_bytes()),
            range: edit.range,
            removed: edit.removed,
            inserted: edit.inserted,
        };
        self.deferred.push_back(AcceptedCodeInput {
            history,
            joins_previous: false,
            kind: AcceptedKind::Closer,
        });
        let progress = self.progress.as_mut().unwrap();
        progress.changed = true;
        progress.active = true;
        progress.id = 1;
        let source_end = self
            .engine
            .source
            .line_to_byte(progress.certificate.units[0].source_lines.start);
        let source = self.code.body.end..source_end;
        let mut change = self.install_code_frame(
            cursor,
            generation,
            display_range,
            source,
            false,
            Some(source_change),
            FrameKind::Fence,
        );
        change.work.metadata_items += source_work.metadata_items;
        change.work.inspected_source_bytes += source_work.inspected_source_bytes;
        change.work.copied_bytes += source_work.copied_bytes;
        change.work.copied_bytes += closer.len() * 2;
        change.work.inspected_source_bytes += closer.len();
        Ok(change)
    }

    pub fn continue_projection(
        &mut self,
        continuation: ProjectionContinuation,
    ) -> Result<BoundedProgress, BoundedError> {
        if continuation.cursor != self.cursor() || self.continuation() != Some(continuation) {
            return Err(BoundedError::StaleCursor);
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or(BoundedError::Editor(EditorError::RevisionExhausted))?;
        let progress = self.progress.as_mut().unwrap();
        let mut visits = 0;
        while visits < 8
            && progress.next < progress.code.len()
            && progress.code[progress.next] != progress.restore
        {
            progress.next += 1;
            visits += 1;
        }
        if progress.next == progress.code.len() || visits == 8 {
            if progress.next == progress.code.len() {
                progress.active = false;
            }
            self.generation = generation;
            return Ok(BoundedProgress::Status(BoundedProgressStatus {
                previous: continuation.cursor,
                cursor: self.cursor(),
                selection: self.engine.selection,
                affinity: self.engine.affinity,
                continuation: self.continuation(),
                work: BoundedWork {
                    metadata_items: visits + 1,
                    ..Default::default()
                },
            }));
        }
        let index = progress.next;
        if progress.restore {
            self.restore_unit(continuation.cursor, generation, index)
                .map(BoundedProgress::Change)
        } else {
            self.convert_unit(continuation.cursor, generation, index)
                .map(BoundedProgress::Change)
        }
    }

    pub(super) fn convert_unit(
        &mut self,
        previous: BoundedCursor,
        generation: u64,
        index: usize,
    ) -> Result<BoundedProgressChange, BoundedError> {
        let progress = self.progress.as_ref().unwrap();
        let unit = &progress.certificate.units[index];
        let last = index + 1 == progress.certificate.units.len();
        let source = unit_source(&self.engine.source, unit, last);
        let display = unit_display(&self.display, unit, last, progress.frame_lines);
        let progress = self.progress.as_mut().unwrap();
        progress.code[index] = true;
        if progress.next == index {
            progress.next += 1;
        }
        Ok(self.install_code_frame(
            previous,
            generation,
            display,
            source,
            last,
            None,
            FrameKind::Region,
        ))
    }

    fn code_fragments(
        &self,
        text: &str,
        range: DisplayRange,
        source: std::ops::Range<usize>,
        terminal: bool,
    ) -> (Vec<BoundedBlock>, BoundedWork) {
        let mut work = BoundedWork::default();
        let before = if source.start == self.code.body.start {
            false
        } else {
            let at = self.engine.source.byte_to_char(source.start);
            self.engine
                .source
                .get_char(at.saturating_sub(1))
                .is_some_and(|ch| {
                    work.inspected_source_bytes += ch.len_utf8();
                    ch != '\n'
                })
        };
        let after = if terminal {
            false
        } else {
            self.engine
                .source
                .get_char(self.engine.source.byte_to_char(source.end))
                .is_some_and(|ch| {
                    work.inspected_source_bytes += ch.len_utf8();
                    !matches!(ch, '\r' | '\n')
                })
        };
        let mut blocks = Vec::new();
        let mut offset = 0;
        for line in text.split_inclusive('\n') {
            let content = line.trim_end_matches(['\r', '\n']).len();
            blocks.push(BoundedBlock {
                description: crate::BlockDescription {
                    range: DisplayRange {
                        start: DisplayOffset(range.start.0 + offset),
                        end: DisplayOffset(range.start.0 + offset + content),
                    },
                    heading: 0,
                    quote_depth: 0,
                    divider: false,
                    list: None,
                    code: true,
                    language: self.code.language.clone(),
                },
                source_owner: Some(SourceOffset(self.code.whole.start)),
                continues_before: offset == 0 && before,
                continues_after: offset + line.len() == text.len()
                    && !line.ends_with('\n')
                    && after,
            });
            offset += line.len();
        }
        // Terminal hidden endings retain their map, not an extra EOF block.
        if text.is_empty() && (range.start.0 < self.display.len_bytes() || before) {
            blocks.push(BoundedBlock {
                description: crate::BlockDescription {
                    range: DisplayRange {
                        start: range.end,
                        end: range.end,
                    },
                    heading: 0,
                    quote_depth: 0,
                    divider: false,
                    list: None,
                    code: true,
                    language: self.code.language.clone(),
                },
                source_owner: Some(SourceOffset(self.code.whole.start)),
                continues_before: text.is_empty() && before,
                continues_after: text.is_empty() && after,
            });
        }
        work.metadata_items += blocks.len();
        work.copied_bytes += blocks.len() * self.code.language.as_ref().map_or(0, String::len);
        (blocks, work)
    }

    pub(super) fn install_code_frame(
        &mut self,
        previous: BoundedCursor,
        generation: u64,
        range: DisplayRange,
        source: std::ops::Range<usize>,
        terminal: bool,
        source_change: Option<BoundedSourceChange>,
        kind: FrameKind,
    ) -> BoundedProgressChange {
        let mut raw = self.engine.source.byte_slice(source.clone()).to_string();
        let source_bytes = raw.len();
        let ending = if terminal && raw.ends_with("\r\n") {
            2
        } else {
            usize::from(terminal && raw.ends_with('\n'))
        };
        raw.truncate(raw.len() - ending);
        let old = self
            .display
            .byte_slice(range.start.0..range.end.0)
            .to_string();
        let same = old == raw;
        let old_lines = Rope::from_str(&old).len_lines();
        let new_lines = Rope::from_str(&raw).len_lines();
        let a = self.display.byte_to_char(range.start.0);
        let z = self.display.byte_to_char(range.end.0);
        self.display.remove(a..z);
        self.display.insert(a, &raw);
        if matches!(kind, FrameKind::Fence) {
            self.progress.as_mut().unwrap().frame_lines = new_lines - old_lines;
        }
        let selection_visits = self.reproject_code_selection();
        self.generation = generation;
        let semantic = DisplayRange {
            start: range.start,
            end: DisplayOffset(range.start.0 + raw.len()),
        };
        let mut mapping = vec![BoundedMap {
            source: SourceRange {
                start: SourceOffset(source.start),
                end: SourceOffset(source.end - ending),
            },
            display: semantic,
            kind: BoundedMapKind::Literal,
        }];
        if ending != 0 {
            mapping.push(BoundedMap {
                source: SourceRange {
                    start: SourceOffset(source.end - ending),
                    end: SourceOffset(source.end),
                },
                display: DisplayRange {
                    start: semantic.end,
                    end: semantic.end,
                },
                kind: BoundedMapKind::Hidden,
            });
        }
        let (blocks, block_work) = self.code_fragments(&raw, semantic, source.clone(), terminal);
        let records = mapping.len() + 1 + blocks.len();
        let shown = if same { String::new() } else { raw.clone() };
        let copied_bytes =
            source_bytes + old.len() + shown.len() + raw.len() + block_work.copied_bytes;
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
            inserted: shown,
            selection: self.engine.selection,
            affinity: self.engine.affinity,
            source_change,
            source_footprint: SourceRange {
                start: SourceOffset(source.start),
                end: SourceOffset(source.end),
            },
            projection: BoundedMeaning {
                range: semantic,
                text: raw,
                mapping,
                runs: vec![crate::SemanticRun {
                    range: semantic,
                    formats: Vec::new(),
                }],
                blocks,
                links: Vec::new(),
            },
            continuation: self.continuation(),
            work: BoundedWork {
                inspected_source_bytes: source_bytes + block_work.inspected_source_bytes,
                copied_bytes,
                returned_text_bytes: semantic.end.0 - semantic.start.0
                    + if same {
                        0
                    } else {
                        semantic.end.0 - semantic.start.0
                    },
                returned_records: records,
                metadata_items: 12 + block_work.metadata_items + selection_visits,
                ..Default::default()
            },
        }
    }
}

pub(super) fn unit_source(
    source: &Rope,
    unit: &ParagraphUnit,
    last: bool,
) -> std::ops::Range<usize> {
    source.line_to_byte(unit.source_lines.start)..if last {
        source.len_bytes()
    } else {
        source.line_to_byte(unit.source_lines.end)
    }
}
pub(super) fn unit_display(
    display: &Rope,
    unit: &ParagraphUnit,
    last: bool,
    frame_lines: usize,
) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(display.line_to_byte(unit.display_lines.start + frame_lines)),
        end: DisplayOffset(if last {
            display.len_bytes()
        } else {
            display.line_to_byte(unit.display_lines.end + frame_lines)
        }),
    }
}
