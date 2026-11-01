use std::mem::size_of;

use futo_notes_editor as core;

use super::super::{
    EditorBlockDescription, EditorByteRange, EditorSemanticRun, EditorSourceByteRange,
};
use super::contract::*;

impl From<EditorBoundedCursor> for core::BoundedCursor {
    fn from(value: EditorBoundedCursor) -> Self {
        Self {
            token: core::SessionToken(value.token),
            incarnation: value.incarnation,
            revision: core::Revision(value.revision),
            generation: value.generation,
        }
    }
}
impl From<core::BoundedCursor> for EditorBoundedCursor {
    fn from(value: core::BoundedCursor) -> Self {
        Self {
            token: value.token.0,
            incarnation: value.incarnation,
            revision: value.revision.0,
            generation: value.generation,
        }
    }
}
impl From<EditorProjectionContinuation> for core::ProjectionContinuation {
    fn from(value: EditorProjectionContinuation) -> Self {
        Self {
            id: value.id,
            cursor: value.cursor.into(),
        }
    }
}

/// Each returned record is charged as it is converted. Vec element buffers are
/// allocated here; existing owned text is moved, never cloned for conversion.
#[derive(Default)]
pub(super) struct Conversion(pub EditorBoundedConversionWork);
impl Conversion {
    fn record(&mut self) {
        self.0.records += 1;
    }
    fn vector<T, U>(&mut self, values: Vec<T>, convert: impl Fn(&mut Self, T) -> U) -> Vec<U> {
        self.0.allocated_vector_bytes += (values.len() * size_of::<U>()) as u64;
        // Allocate explicitly rather than depending on collect's possible
        // in-place reuse of the canonical vector's differently typed buffer.
        let mut output = Vec::with_capacity(values.len());
        for value in values {
            output.push(convert(self, value));
        }
        output
    }
    fn text(&mut self, value: String) -> String {
        self.0.moved_text_bytes += value.len() as u64;
        value
    }
    fn optional_text(&mut self, value: Option<String>) -> Option<String> {
        value.map(|text| self.text(text))
    }
    fn cursor(&mut self, value: core::BoundedCursor) -> EditorBoundedCursor {
        self.record();
        value.into()
    }
    fn range(&mut self, value: core::DisplayRange) -> EditorByteRange {
        self.record();
        value.into()
    }
    fn source(&mut self, value: core::SourceRange) -> EditorSourceByteRange {
        self.record();
        EditorSourceByteRange {
            start: value.start.0 as u64,
            end: value.end.0 as u64,
        }
    }
    fn continuation(
        &mut self,
        value: Option<core::ProjectionContinuation>,
    ) -> Option<EditorProjectionContinuation> {
        value.map(|value| {
            self.record();
            EditorProjectionContinuation {
                id: value.id,
                cursor: self.cursor(value.cursor),
            }
        })
    }
    pub(super) fn work(&mut self, value: core::BoundedWork) -> EditorBoundedWork {
        self.record();
        EditorBoundedWork {
            inspected_source_bytes: value.inspected_source_bytes as u64,
            input_bytes: value.input_bytes as u64,
            parsed_source_bytes: value.parsed_source_bytes as u64,
            copied_bytes: value.copied_bytes as u64,
            metadata_items: value.metadata_items as u64,
            retired_history_records: value.retired_history_records as u64,
            retired_history_payload_bytes: value.retired_history_payload_bytes as u64,
            returned_text_bytes: value.returned_text_bytes as u64,
            returned_records: value.returned_records as u64,
        }
    }
    fn source_change(&mut self, value: core::BoundedSourceChange) -> EditorBoundedSourceChange {
        self.record();
        EditorBoundedSourceChange {
            range: self.source(value.range),
            inserted_bytes: value.inserted_bytes as u64,
        }
    }
    pub(super) fn change(mut self, value: core::BoundedChange) -> EditorBoundedChange {
        self.record(); // BoundedChange
        self.record(); // CodeProjection
        self.record(); // CodeIdentity
        self.record(); // CodeFragment
        let projection = EditorBoundedCodeProjection {
            range: self.range(value.projection.range),
            text: self.text(value.projection.text),
            identity: EditorCodeIdentity {
                source: self.source(value.projection.identity.source),
                display: self.range(value.projection.identity.display),
            },
            block: EditorCodeFragment {
                owner: value.projection.block.owner.0 as u64,
                range: self.range(value.projection.block.range),
                language: self.optional_text(value.projection.block.language),
            },
        };
        EditorBoundedChange {
            previous: self.cursor(value.previous),
            cursor: self.cursor(value.cursor),
            range: self.range(value.range),
            inserted: self.text(value.inserted),
            selection: self.range(value.selection),
            affinity: value.affinity.into(),
            projection,
            source_change: self.source_change(value.source_change),
            continuation: self.continuation(value.continuation),
            work: self.work(value.work),
            conversion: self.0,
        }
    }
    fn block(&mut self, value: core::BlockDescription) -> EditorBlockDescription {
        self.record();
        if value.list.is_some() {
            self.record();
        }
        EditorBlockDescription {
            range: self.range(value.range),
            heading: value.heading,
            quote_depth: value.quote_depth as u64,
            divider: value.divider,
            list: value.list.map(Into::into),
            code: value.code,
            language: self.optional_text(value.language),
            metadata: value.metadata,
        }
    }
    fn meaning(&mut self, value: core::BoundedMeaning) -> EditorBoundedMeaning {
        self.record();
        let mapping = self.vector(value.mapping, |conversion, value| {
            conversion.record();
            EditorBoundedMap {
                source: conversion.source(value.source),
                display: conversion.range(value.display),
                kind: match value.kind {
                    core::BoundedMapKind::Literal => EditorBoundedMapKind::Literal,
                    core::BoundedMapKind::Atom => EditorBoundedMapKind::Atom,
                    core::BoundedMapKind::Hidden => EditorBoundedMapKind::Hidden,
                },
            }
        });
        let runs = self.vector(value.runs, |conversion, value| {
            conversion.record();
            EditorSemanticRun {
                range: conversion.range(value.range),
                formats: conversion.vector(value.formats, |_, format| format.into()),
            }
        });
        let blocks = self.vector(value.blocks, |conversion, value| {
            conversion.record();
            EditorBoundedBlock {
                description: conversion.block(value.description),
                source_owner: value.source_owner.map(|value| value.0 as u64),
                continues_before: value.continues_before,
                continues_after: value.continues_after,
            }
        });
        let links = self.vector(value.links, |conversion, value| {
            conversion.record(); // LinkDescription
            conversion.record(); // Its display range, converted by the existing leaf.
            conversion.0.moved_text_bytes += value.destination.len() as u64
                + value.title.as_ref().map_or(0, |value| value.len() as u64);
            value.into()
        });
        EditorBoundedMeaning {
            range: self.range(value.range),
            text: self.text(value.text),
            mapping,
            runs,
            blocks,
            links,
        }
    }
    pub(super) fn progress_change(
        mut self,
        value: core::BoundedProgressChange,
    ) -> EditorBoundedProgressChange {
        self.record();
        EditorBoundedProgressChange {
            previous: self.cursor(value.previous),
            cursor: self.cursor(value.cursor),
            range: self.range(value.range),
            inserted: self.text(value.inserted),
            selection: self.range(value.selection),
            affinity: value.affinity.into(),
            source_change: value.source_change.map(|value| self.source_change(value)),
            source_footprint: self.source(value.source_footprint),
            projection: self.meaning(value.projection),
            continuation: self.continuation(value.continuation),
            work: self.work(value.work),
            conversion: self.0,
        }
    }
    pub(super) fn progress(self, value: core::BoundedProgress) -> EditorBoundedProgress {
        match value {
            core::BoundedProgress::Change(value) => EditorBoundedProgress::Change {
                change: Box::new(self.progress_change(value)),
            },
            core::BoundedProgress::Status(value) => {
                let mut conversion = self;
                conversion.record();
                EditorBoundedProgress::Status {
                    status: Box::new(EditorBoundedProgressStatus {
                        previous: conversion.cursor(value.previous),
                        cursor: conversion.cursor(value.cursor),
                        selection: conversion.range(value.selection),
                        affinity: value.affinity.into(),
                        continuation: conversion.continuation(value.continuation),
                        work: conversion.work(value.work),
                        conversion: conversion.0,
                    }),
                }
            }
        }
    }
}
