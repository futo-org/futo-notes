use super::*;
impl PortableBoundedSession {
    pub fn acknowledge(
        &mut self,
        ack: BoundedHostAck,
    ) -> Result<Option<BoundedFrame>, PortableError> {
        self.reset_operation_work();
        let Some(request) = &self.waiting else {
            return Ok(None);
        };
        if ack.token != self.mode.request.token
            || ack.incarnation != self.mode.incarnation
            || ack.sequence != request.sequence
        {
            return Ok(None);
        }
        let limit = match &request.operation {
            BoundedHostOperation::Append { edit, .. } => edit.revision,
            BoundedHostOperation::Flush => self.accepted,
            BoundedHostOperation::Resume => self.engine.source_authority().revision,
        };
        if ack.durable.0 > ack.accepted.0
            || ack.accepted.0 < self.accepted.0
            || ack.durable.0 < self.durable.0
            || ack.accepted.0 > limit.0
        {
            return Err(PortableError::InvalidAcknowledgement);
        }
        if ack.error.is_none() && !ack.paused && !ack.reset_required {
            let expected = match &request.operation {
                BoundedHostOperation::Append { edit, .. } => Some(edit.revision),
                BoundedHostOperation::Flush => Some(self.accepted),
                BoundedHostOperation::Resume => None,
            };
            if expected.is_some_and(|expected| ack.accepted != expected)
                || (matches!(
                    request.operation,
                    BoundedHostOperation::Flush | BoundedHostOperation::Resume
                ) && ack.durable != ack.accepted)
            {
                return Err(PortableError::InvalidAcknowledgement);
            }
        }
        self.waiting = None;
        self.accepted = ack.accepted;
        self.durable = ack.durable;
        self.reset_required = ack.reset_required;
        self.paused = ack.paused || ack.error.is_some();
        if !self.paused
            && !self.reset_required
            && self
                .pending
                .as_ref()
                .is_some_and(|(edit, _, _)| edit.revision == self.accepted)
        {
            let (_, _, frame) = self.pending.take().unwrap();
            self.displayed = frame.revision();
            return Ok(Some(frame));
        }
        Ok(None)
    }
}
