//! Image and divider atoms. Rows keep image syntax and its parsed meaning;
//! queries describe the atoms overlapping a window without scanning other rows.
//! An image's display text keeps its source spelling, so the role carries the
//! atom boundaries a renderer needs.
use super::row::{LinkMeaning, Row};
use crate::{AtomDescription, AtomKind, DisplayOffset, DisplayRange, ImageDescription};
use std::ops::Range;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub(crate) struct RowImage {
    /// The whole `![alt](destination)` (or reference form) in row source.
    pub source: Range<usize>,
    /// The alt text's source spelling.
    pub alt: String,
    pub meaning: Arc<LinkMeaning>,
}

impl super::Projection {
    pub(crate) fn atom_descriptions(&self, range: DisplayRange) -> Vec<AtomDescription> {
        let first = self.rows.locate(range.start.0, true);
        let last = self.rows.locate(range.end.0, true);
        let mut out = Vec::new();
        for index in first..=last {
            let (row, _, display) = self.rows.at(index);
            let mut row_atoms = Vec::new();
            for image in &row.images {
                row_atoms.push(describe_image(row, display, image));
            }
            for block in row.blocks.iter().filter(|block| block.divider) {
                row_atoms.push(atom(
                    AtomKind::Divider,
                    display + row.display_at(block.content.start),
                    display + row.display_at(block.content.end),
                    None,
                ));
            }
            row_atoms.sort_by_key(|atom| atom.range.start.0);
            out.extend(row_atoms.into_iter().filter(|atom| {
                atom.range.start.0 <= range.end.0 && range.start.0 <= atom.range.end.0
            }));
        }
        out
    }
}

fn atom(
    kind: AtomKind,
    start: usize,
    end: usize,
    image: Option<ImageDescription>,
) -> AtomDescription {
    AtomDescription {
        kind,
        range: DisplayRange {
            start: DisplayOffset(start),
            end: DisplayOffset(end),
        },
        before: DisplayOffset(start),
        after: DisplayOffset(end),
        image,
    }
}

fn describe_image(row: &Row, display: usize, image: &RowImage) -> AtomDescription {
    let destination = image.meaning.destination.clone();
    atom(
        AtomKind::Image,
        display + row.display_at(image.source.start),
        display + row.display_at(image.source.end),
        Some(ImageDescription {
            alt: image.alt.clone(),
            vault: futo_notes_image::is_vault_image_reference(&destination),
            destination,
            title: image.meaning.title.clone(),
            reference: image.meaning.reference.as_ref().map(|key| key.to_string()),
        }),
    )
}
