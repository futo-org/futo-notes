//! Coordinate and planning helpers every native renderer needs and none should
//! rewrite: they hold no Markdown rules, only the engine's display text.

mod display_mirror;
pub use display_mirror::{DisplayMirror, MirrorEdit, MirrorError};
