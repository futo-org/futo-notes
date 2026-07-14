use crate::checkpoint::{ConnectedState, ObjectState};
use crate::server::Object;

pub(super) fn mapped_name(state: &ConnectedState, object_id: &str) -> Option<String> {
    state
        .object_map
        .iter()
        .find(|(_, entry)| entry.object_id == object_id)
        .map(|(name, _)| name.clone())
}

pub(super) fn object_is_current(entry: &ObjectState, object: &Object) -> bool {
    entry.version == object.version
        && entry.blob_key == object.blob_key.as_deref().unwrap_or_default()
}
