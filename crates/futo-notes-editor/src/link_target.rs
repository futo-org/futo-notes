//! Where a link destination goes when tapped. The editor opens only what this calls external;
//! a relative path, note name, fragment or `.md` file is never a web address.

/// File extensions that are also registered top-level domains, so `other.md` or `scan.pdf` looks
/// like a host to any host-shaped test. A destination ending in one names a file, not a site.
const FILE_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "pdf", "doc", "docx", "csv", "json", "html", "htm", "png", "jpg",
    "jpeg", "gif", "webp", "heic", "svg", "mp3", "m4a", "mp4", "mov",
];

/// The address to open for a tapped link destination, or `None` when it is not external.
///
/// A destination with a scheme is external as written (the shell's scheme policy decides whether
/// it opens). One without a scheme is external only when it is a bare domain, `example.com` or
/// `www.example.com/path`, which opens as `https://`. A path ending in `.md` is a note, never a
/// domain.
pub fn external_link_url(destination: &str) -> Option<String> {
    let destination = destination.trim();
    if destination.is_empty()
        || destination
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    if has_scheme(destination) {
        return Some(destination.to_owned());
    }
    let path_end = destination.find(['?', '#']).unwrap_or(destination.len());
    if destination[..path_end]
        .to_ascii_lowercase()
        .ends_with(".md")
    {
        return None;
    }
    let host_end = destination
        .find(['/', '?', '#'])
        .unwrap_or(destination.len());
    let authority = &destination[..host_end];
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return None,
        None => authority,
    };
    is_domain(host).then(|| format!("https://{destination}"))
}

fn has_scheme(destination: &str) -> bool {
    let Some((scheme, _)) = destination.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-')
        // `host:8080` is a bare domain with a port, not a scheme.
        && !destination[scheme.len() + 1..]
            .split(['/', '?', '#'])
            .next()
            .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit()))
}

fn is_domain(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    let Some(tld) = labels.last().filter(|_| labels.len() >= 2) else {
        return false;
    };
    labels.iter().all(|label| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label.chars().all(|c| c.is_alphanumeric() || c == '-')
    }) && tld.chars().count() >= 2
        && tld.chars().all(char::is_alphabetic)
        && !FILE_EXTENSIONS.contains(&tld.to_ascii_lowercase().as_str())
}
