//! Image insertion is ordinary input; a claim is a plain session fact.
use super::*;
use crate::ImageClaim;

impl PortableSession {
    pub fn image_claim(&self) -> ImageClaim {
        self.engine.image_claim()
    }

    /// `None` when the caret is in code and nothing was inserted.
    pub fn insert_image(
        &mut self,
        expected: Revision,
        claim: ImageClaim,
        reference: &str,
        alt: &str,
    ) -> Result<Option<Applied>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .insert_image(expected, claim, reference, alt, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        Ok(change.map(|change| self.issue(record.unwrap(), change)))
    }
}
