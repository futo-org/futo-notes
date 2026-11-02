//! Multiple actual separators leave a newly Inserted capsule literal, not live.
use super::*;

impl TypedState {
    pub(super) fn literal_ending(
        &mut self,
        input: &Input<'_>,
        pieces: &mut [Piece],
        markers: &[Marker],
        work: &mut ReferenceWork,
    ) -> Result<(), EditorError> {
        let mut end = input.insertion.end;
        let mut separators = 0;
        while input.insertion.start < end {
            work.items += 1;
            if !single_whitespace(&pieces[end - 1].display, &mut work.items) {
                break;
            }
            separators += 1;
            end -= 1;
        }
        if separators < 2 || end <= input.insertion.start || pieces[end - 1].display != ">" {
            return Ok(());
        }
        let close = end - 1;
        let mut start = close;
        while input.insertion.start < start {
            work.items += 1;
            if pieces[start - 1].display.chars().any(|ch| {
                work.items += 1;
                ch.is_whitespace()
            }) {
                break;
            }
            start -= 1;
        }
        if start == close || pieces[start].display != "<" {
            return Ok(());
        }
        let body = start + 1..close;
        if body.is_empty()
            || !safe(&pieces[start..end], markers, &mut work.items)
            || opaque(input, pieces, &mut work.items)
        {
            return Ok(());
        }
        let text = displayed(&pieces[body.clone()], work);
        let (target, _) = meaning(&text, work);
        if target.is_none() {
            return Ok(());
        }
        // The maintained bare-link parser has certified the complete body.
        // Escape its actual scheme colon, or WWW's own separating dot. This
        // changes ordinary spelling only; no timing or owner field is set.
        work.items += 1;
        let punctuation = if text
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("www."))
        {
            body.clone().find(|index| {
                work.items += 1;
                pieces[*index].display == "."
            })
        } else {
            body.clone().find(|index| {
                work.items += 1;
                pieces[*index].display == ":"
            })
        }
        .ok_or(EditorError::UnrepresentableFormat)?;
        let scalar = &mut pieces[punctuation];
        let escaped = format!("\\{}", scalar.display);
        work.copied += escaped.len();
        scalar.raw = escaped;
        work.items += 1;
        self.literal_capsules.push(start..end);
        Ok(())
    }
}
