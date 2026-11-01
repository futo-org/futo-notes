use super::*;
use crate::{
    BoundedCursor, BoundedModeReady, BoundedModeRequest, PortableBoundedSession,
    ProjectionContinuation,
};

/// Additive WASM owner. Existing WasmSession methods/signatures stay intact.
/// Entry retains one page engine; completing or canceling moves that owner.
#[wasm_bindgen]
pub struct WasmBoundedSession(Option<Page>);
enum Page {
    Entry {
        session: PortableSession,
        request: BoundedModeRequest,
    },
    Bounded(PortableBoundedSession),
}
impl WasmBoundedSession {
    fn page(&self) -> Result<&PortableBoundedSession, JsValue> {
        match &self.0 {
            Some(Page::Bounded(page)) => Ok(page),
            _ => Err(error("bounded page unavailable")),
        }
    }
    fn page_mut(&mut self) -> Result<&mut PortableBoundedSession, JsValue> {
        match &mut self.0 {
            Some(Page::Bounded(page)) => Ok(page),
            _ => Err(error("bounded page unavailable")),
        }
    }
}
fn decode<T: serde::de::DeserializeOwned>(wire: &str, limit: usize) -> Result<T, JsValue> {
    if wire.len() > limit {
        return Err(error("bounded wire payload exceeds capability"));
    }
    serde_json::from_str(wire).map_err(error)
}
#[wasm_bindgen]
impl WasmBoundedSession {
    #[wasm_bindgen(constructor)]
    pub fn new(snapshot: &str, body_caret: usize) -> Result<Self, JsValue> {
        let snapshot: crate::HostSnapshot = serde_json::from_str(snapshot).map_err(error)?;
        validate_wire(snapshot.token.0, snapshot.revision.0, snapshot.durable.0)?;
        let mut session = PortableSession::from_snapshot(snapshot).map_err(error)?;
        let request = session
            .begin_bounded_entry(DisplayOffset(body_caret))
            .map_err(error)?;
        Ok(Self(Some(Page::Entry { session, request })))
    }
    pub fn entry_request(&self) -> Result<String, JsValue> {
        match &self.0 {
            Some(Page::Entry { request, .. }) => json(request),
            _ => Err(error("entry unavailable")),
        }
    }
    pub fn complete_entry(&mut self, ready: &str) -> Result<(), JsValue> {
        let ready: BoundedModeReady = decode(ready, 1024)?;
        validate_wire(
            ready.request.token.0,
            ready.request.revision.0,
            ready.durable.0,
        )?;
        if ready.incarnation > 9_007_199_254_740_991
            || ready.request.sequence > 9_007_199_254_740_991
        {
            return Err(error("inexact bounded wire integer"));
        }
        let (session, request) = match self.0.take() {
            Some(Page::Entry { session, request }) => (session, request),
            other => {
                self.0 = other;
                return Err(error("entry unavailable"));
            }
        };
        match session.complete_bounded_entry(ready) {
            Ok(page) => {
                self.0 = Some(Page::Bounded(page));
                Ok(())
            }
            Err(failure) => {
                self.0 = Some(Page::Entry {
                    session: *failure.session,
                    request,
                });
                Err(error(failure.error))
            }
        }
    }
    pub fn cancel_entry(&mut self) -> Result<WasmSession, JsValue> {
        match self.0.take() {
            Some(Page::Entry { mut session, .. }) => {
                session.cancel_bounded_entry();
                Ok(WasmSession(session))
            }
            other => {
                self.0 = other;
                Err(error("entry unavailable"))
            }
        }
    }
    pub fn cursor(&self) -> Result<String, JsValue> {
        json(&self.page()?.cursor().map_err(error)?)
    }
    pub fn status(&self) -> Result<String, JsValue> {
        json(&self.page()?.status())
    }
    pub fn draft_text(&self) -> Result<String, JsValue> {
        Ok(self.page()?.draft_text())
    }
    pub fn remove_fence_closer(&mut self, cursor: &str) -> Result<String, JsValue> {
        let cursor: BoundedCursor = decode(cursor, 512)?;
        json(
            &self
                .page_mut()?
                .remove_fence_closer(cursor)
                .map_err(error)?,
        )
    }
    pub fn insert_literal(
        &mut self,
        cursor: &str,
        at: usize,
        inserted: &str,
    ) -> Result<String, JsValue> {
        let cursor: BoundedCursor = decode(cursor, 512)?;
        json(
            &self
                .page_mut()?
                .insert_literal(cursor, DisplayOffset(at), inserted)
                .map_err(error)?,
        )
    }
    pub fn insert_literal_utf16(
        &mut self,
        cursor: &str,
        at: usize,
        inserted: &[u16],
    ) -> Result<String, JsValue> {
        let cursor: BoundedCursor = decode(cursor, 512)?;
        json(
            &self
                .page_mut()?
                .insert_literal_utf16(cursor, DisplayOffset(at), inserted)
                .map_err(error)?,
        )
    }
    pub fn select(
        &mut self,
        cursor: &str,
        start: usize,
        end: usize,
        affinity: &str,
    ) -> Result<String, JsValue> {
        let cursor: BoundedCursor = decode(cursor, 512)?;
        let affinity: crate::Affinity = decode(affinity, 32)?;
        json(
            &self
                .page_mut()?
                .select_bounded(
                    cursor,
                    DisplayRange {
                        start: DisplayOffset(start),
                        end: DisplayOffset(end),
                    },
                    affinity,
                )
                .map_err(error)?,
        )
    }
    pub fn continue_projection(&mut self, continuation: &str) -> Result<String, JsValue> {
        let continuation: ProjectionContinuation = decode(continuation, 512)?;
        json(
            &self
                .page_mut()?
                .continue_projection(continuation)
                .map_err(error)?,
        )
    }
    pub fn undo(&mut self, cursor: &str) -> Result<String, JsValue> {
        let cursor = decode(cursor, 512)?;
        json(&self.page_mut()?.undo_bounded(cursor).map_err(error)?)
    }
    pub fn redo(&mut self, cursor: &str) -> Result<String, JsValue> {
        let cursor = decode(cursor, 512)?;
        json(&self.page_mut()?.redo_bounded(cursor).map_err(error)?)
    }
    pub fn flush(&mut self) -> Result<String, JsValue> {
        json(&self.page_mut()?.flush().map_err(error)?)
    }
    pub fn resume(&mut self) -> Result<String, JsValue> {
        json(&self.page_mut()?.resume().map_err(error)?)
    }
    pub fn retry_pending(&mut self) -> Result<String, JsValue> {
        json(&self.page_mut()?.retry_pending().map_err(error)?)
    }
    pub fn acknowledge(&mut self, ack: &str) -> Result<String, JsValue> {
        let ack = decode(ack, 4096)?;
        json(&self.page_mut()?.acknowledge(ack).map_err(error)?)
    }
    pub fn materialize(&mut self) -> Result<WasmSession, JsValue> {
        match self.0.take() {
            Some(Page::Bounded(page)) => match page.into_full() {
                Ok((session, _)) => Ok(WasmSession(session)),
                Err(failure) => {
                    self.0 = Some(Page::Bounded(*failure.session));
                    Err(error(failure.error))
                }
            },
            other => {
                self.0 = other;
                Err(error("bounded page unavailable"))
            }
        }
    }
}
