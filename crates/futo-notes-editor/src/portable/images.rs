//! Image insertion uses the ordered append/ack barrier; a claim is a plain
//! session fact and needs no barrier.
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
    ) -> Result<Option<HostRequest>, PortableError> {
        self.ready()?;
        let mut record = None;
        let change = self
            .engine
            .insert_image(expected, claim, reference, alt, &mut |edit| {
                record = Some(edit.clone());
                Ok(())
            })?;
        change
            .map(|change| self.stage(record.unwrap(), change))
            .transpose()
    }
}
