//! Image filename detection. The canonical set + predicate live in
//! `futo-notes-core::image` (single source of truth, conformance-locked
//! against `packages/editor/src/images.ts`); the note domain re-exports them so
//! existing `model::is_image_filename` / `model::IMAGE_EXTENSIONS` callers and
//! the conformance harness resolve unchanged.

pub use futo_notes_core::image::{is_image_filename, IMAGE_EXTENSIONS};
