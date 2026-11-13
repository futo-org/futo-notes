//! The `engine` feature: a session runs on the rebuilt core (`crate::engine`).
//! The feature is for trying the core end to end on a device and is never
//! enabled in a shipping build; the cut-over replaces this file.
//!
//! Methods on the editing path hand over to the core through `on_next!`.
//! The old fields the rest of this module reads directly (revision,
//! selection, affinity, marked text and the source rope) follow the core
//! after every call, so saving, tags and the store's checks keep working.
//! Commands the core does not have yet change nothing.
use super::*;
use crate::engine::Engine;

impl EditorSession {
    pub(super) fn on_engine(
        source: &str,
        revision: Revision,
        clock: Arc<dyn HistoryClock>,
    ) -> Self {
        let mut session = Self::with_projection(
            "",
            revision,
            clock.clone(),
            crate::inline::Projection::new(""),
        );
        session.source = Rope::from_str(source);
        session.next = Some(Box::new(Engine::restore_with_clock(
            source, revision, clock,
        )));
        session.follow_next();
        session
    }

    /// Run `f` on the core, then follow it.
    pub(crate) fn with_next<R>(&mut self, f: impl FnOnce(&mut Engine) -> R) -> R {
        let result = f(self.next.as_deref_mut().expect("on the core"));
        self.follow_next();
        result
    }

    /// Run `f` on the core with `accept`, mirroring each accepted edit into
    /// the source rope, then follow it.
    pub(crate) fn with_next_accept<R>(
        &mut self,
        accept: &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
        f: impl FnOnce(&mut Engine, &mut dyn FnMut(&SourceEdit) -> Result<(), String>) -> R,
    ) -> R {
        let mut accepted: Vec<SourceEdit> = Vec::new();
        let result = {
            let mut logged = |edit: &SourceEdit| {
                accept(edit)?;
                accepted.push(edit.clone());
                Ok(())
            };
            f(self.next.as_deref_mut().expect("on the core"), &mut logged)
        };
        for edit in accepted {
            let start = self.source.byte_to_char(edit.range.start.0);
            let end = self.source.byte_to_char(edit.range.end.0);
            self.source.remove(start..end);
            self.source.insert(start, &edit.inserted);
        }
        self.follow_next();
        result
    }

    fn follow_next(&mut self) {
        let engine = self.next.as_deref().expect("on the core");
        self.revision = engine.revision();
        self.selection = engine.selection();
        self.affinity = engine.affinity();
        self.composition = engine.composition().map(|marked| Composition {
            revision: marked.revision,
            range: marked.range,
            text: marked.text.clone(),
            runs: marked_runs(engine, marked.range, &marked.text),
        });
    }
}

/// How marked text draws until it commits, as the surface reports it.
pub(crate) fn marked_runs(engine: &Engine, range: DisplayRange, text: &str) -> Vec<MarkedRun> {
    engine
        .marked_runs(range, text)
        .into_iter()
        .map(|(range, formats)| MarkedRun {
            start: range.start,
            end: range.end,
            formats,
        })
        .collect()
}
