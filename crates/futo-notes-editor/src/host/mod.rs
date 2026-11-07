//! Coordinate and planning helpers every native renderer needs and none should
//! rewrite: they hold no Markdown rules, only the engine's display text.

mod display_mirror;
pub use display_mirror::{DisplayMirror, MirrorEdit, MirrorError};

mod pending_edits;
pub use pending_edits::PendingEdits;

mod quick_plan;
pub use quick_plan::plan_quick_open;

mod style_plan;
pub use style_plan::{plan_styles, ListMarker, StyleSpec, TableCellSpan};

mod table_plan;
pub use table_plan::plan_tables;
