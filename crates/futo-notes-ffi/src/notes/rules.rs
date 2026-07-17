use futo_notes_model as model;

#[derive(uniffi::Record)]
pub struct NoteIdParts {
    pub folder: String,
    pub title: String,
}

/// `kind` is the stable snake_case identifier shared with the native shells.
#[derive(uniffi::Record)]
pub struct TitleIssue {
    pub kind: String,
    pub message: String,
}

#[uniffi::export]
pub fn sanitize_title(title: String) -> String {
    model::sanitize_title(&title)
}

#[uniffi::export]
pub fn make_id(folder: String, title: String) -> String {
    model::make_id(&folder, &title)
}

#[uniffi::export]
pub fn split_id(id: String) -> NoteIdParts {
    let (folder, title) = model::split_id(&id);
    NoteIdParts { folder, title }
}

#[uniffi::export]
pub fn extract_tags(content: String) -> Vec<String> {
    model::note_tags(&content)
}

#[uniffi::export]
pub fn make_preview(content: String) -> String {
    model::make_preview(&content)
}

#[uniffi::export]
pub fn image_extensions() -> Vec<String> {
    model::IMAGE_EXTENSIONS
        .iter()
        .map(|extension| (*extension).to_owned())
        .collect()
}

#[uniffi::export]
pub fn validate_title(title: String) -> Vec<TitleIssue> {
    model::validate_title(&title)
        .into_iter()
        .map(|issue| TitleIssue {
            kind: issue.kind.as_str().to_owned(),
            message: issue.message,
        })
        .collect()
}

#[uniffi::export]
pub fn make_rich_preview(content: String) -> String {
    model::make_rich_preview(&content)
}

#[uniffi::export]
pub fn extract_wikilinks(content: String) -> Vec<String> {
    model::extract_wikilinks(&content)
}
