//! Coordinate and planning helpers every native renderer needs and none should
//! rewrite: they hold no Markdown rules, only the engine's display text.

mod display_mirror;
pub use display_mirror::{DisplayMirror, MirrorEdit, MirrorError};

mod find_plan;
pub use find_plan::{plan_find, FindLanding, FindSnapshot, FindStepPlan};

mod style_plan;
pub use style_plan::{plan_styles, ListMarker, StyleSpec};

mod toolbar_ids;
pub use toolbar_ids::{toolbar_highlights, ToolbarHighlights};
