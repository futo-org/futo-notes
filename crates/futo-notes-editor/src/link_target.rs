//! What a link destination means. The link prompt asks [`normalize_link_destination`] (a note
//! that exists wins, then the web-address heuristic) when a
//! destination is saved; a tap asks [`external_link_url`] (opens in the system only with an
//! explicit, allowed scheme) and otherwise [`resolve_note_link`] (a schemeless destination is a
//! note path, never a web address).
use futo_notes_wikilinks::{fold, WikilinkIndex};

/// Schemes that open outside the app. Everything else, `javascript:`, `file:` and `data:`
/// included, never does.
const EXTERNAL_SCHEMES: &[&str] = &["http", "https", "mailto", "tel", "sms"];

/// Top-level domains a typed schemeless address may end in to be saved as `https://`. Deliberately
/// short of the full registry: a TLD that is also a common file extension (`.sh`, `.rs`, `.py`,
/// `.pl`, `.md`, `.zip`, `.mov`, `.cc`, `.so`, `.ml`) is left out, so `setup.sh` and `main.rs` are
/// never taken for sites. An address on a TLD missing here stays as typed.
const WEB_TLDS: &[&str] = &[
    // generic
    "com",
    "org",
    "net",
    "edu",
    "gov",
    "mil",
    "int",
    "info",
    "biz",
    "name",
    "pro",
    "mobi",
    "asia",
    "travel",
    "jobs",
    "museum",
    "coop",
    "aero",
    "xyz",
    "online",
    "site",
    "tech",
    "store",
    "shop",
    "blog",
    "cloud",
    "page",
    "news",
    "wiki",
    "app",
    "dev",
    "io",
    "ai",
    "co",
    "me",
    "tv",
    "fm",
    "club",
    "live",
    "life",
    "world",
    "today",
    "space",
    "website",
    "link",
    "one",
    "top",
    "art",
    "design",
    "studio",
    "agency",
    "digital",
    "email",
    "group",
    "media",
    "network",
    "social",
    "team",
    "tools",
    "work",
    "zone",
    "systems",
    "software",
    "solutions",
    "services",
    "support",
    "press",
    "rocks",
    "ninja",
    "guru",
    "fun",
    "bio",
    "earth",
    "games",
    "chat",
    "community",
    "education",
    "finance",
    "foundation",
    "global",
    "health",
    "institute",
    "international",
    // country codes
    "uk",
    "de",
    "fr",
    "nl",
    "ca",
    "au",
    "jp",
    "cn",
    "in",
    "br",
    "ru",
    "es",
    "it",
    "se",
    "no",
    "fi",
    "dk",
    "ch",
    "at",
    "be",
    "nz",
    "ie",
    "kr",
    "tw",
    "hk",
    "sg",
    "mx",
    "ar",
    "za",
    "ly",
    "to",
    "gg",
    "is",
    "eu",
    "us",
    "ua",
    "cz",
    "gr",
    "pt",
    "tr",
    "il",
    "id",
    "th",
    "vn",
    "my",
    "ph",
    "cl",
    "pe",
    "ro",
    "hu",
    "sk",
    "bg",
    "hr",
    "si",
    "lt",
    "lv",
    "ee",
    "lu",
    "li",
    "ng",
    "ke",
    "eg",
    "ae",
    "sa",
    "pk",
    "bd",
];

/// The address to open for a tapped link destination, or `None` when it must not open in the
/// system: no explicit scheme (a note path, `#fragment` or bare domain), or a scheme outside
/// [`EXTERNAL_SCHEMES`]. The shell's own scheme guard still applies on top.
pub fn external_link_url(destination: &str) -> Option<String> {
    let destination = destination.trim();
    if destination.is_empty()
        || destination
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return None;
    }
    let scheme = scheme_of(destination)?;
    EXTERNAL_SCHEMES
        .iter()
        .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
        .then(|| destination.to_owned())
}

/// The destination to save for what the person typed in the link prompt, from the note
/// `current_id`. A destination that names an existing note (the tap's own resolution) stays as
/// typed, so `logo.ai` or `Projects.dev/todo` never become web addresses; otherwise a schemeless
/// address that looks like one (`www.…`, or a host on a known public TLD, and not ending in
/// `.md`) gains `https://`, and anything else is returned exactly as typed.
pub(crate) fn normalize_link_destination(
    typed: &str,
    current_id: &str,
    catalog: &WikilinkIndex,
) -> String {
    if resolve_note_link(typed, current_id, catalog).is_some() {
        return typed.to_owned();
    }
    web_address_destination(typed)
}

fn web_address_destination(typed: &str) -> String {
    let candidate = typed.trim();
    if candidate.is_empty()
        || candidate
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        || scheme_of(candidate).is_some_and(|scheme| !scheme.contains('.'))
    {
        return typed.to_owned();
    }
    let path_end = candidate.find(['?', '#']).unwrap_or(candidate.len());
    if candidate[..path_end].to_ascii_lowercase().ends_with(".md") {
        return typed.to_owned();
    }
    let authority = &candidate[..candidate.find(['/', '?', '#']).unwrap_or(candidate.len())];
    let host = match authority.rsplit_once(':') {
        Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => host,
        Some(_) => return typed.to_owned(),
        None => authority,
    };
    if looks_like_web_host(host) {
        format!("https://{candidate}")
    } else {
        typed.to_owned()
    }
}

/// The note id a tapped schemeless destination names, or `None` (a fragment, a scheme, or no such
/// note: the tap does nothing). The destination is a path from the folder of `current_id`, or from
/// the vault root when it starts with `/`; `.md` is optional, `#fragment` and `?query` are ignored,
/// `%XX` is decoded, and case is ignored only when it picks a single note.
pub(crate) fn resolve_note_link(
    destination: &str,
    current_id: &str,
    catalog: &WikilinkIndex,
) -> Option<String> {
    let destination = destination.trim();
    if destination.is_empty()
        || destination.starts_with('#')
        || destination.starts_with('?')
        || destination.starts_with("//")
        || destination.chars().any(char::is_control)
        || scheme_of(destination).is_some()
    {
        return None;
    }
    let path = &destination[..destination.find(['?', '#']).unwrap_or(destination.len())];
    let path = percent_decode(path)?;
    let path = match path.to_ascii_lowercase().ends_with(".md") {
        true => &path[..path.len() - 3],
        false => &path[..],
    };
    // Relative to the current note's folder (its id minus its own name), or the vault root.
    let mut parts: Vec<&str> = if path.starts_with('/') {
        Vec::new()
    } else {
        let mut folder: Vec<&str> = current_id.split('/').collect();
        folder.pop();
        folder
    };
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    if parts.is_empty() {
        return None;
    }
    let id = parts.join("/");
    if catalog.contains(&id) {
        return Some(id);
    }
    let folded = fold(&id);
    let mut same = catalog.ordered().filter(|(_, other)| *other == folded);
    let found = same.next()?.0;
    same.next().is_none().then(|| found.to_owned())
}

/// The scheme of `destination` per RFC 3986 (`a-z` first, then letters, digits, `+`, `-`, `.`),
/// or `None`. `host:8080` has the scheme `host`; callers decide what that is worth.
fn scheme_of(destination: &str) -> Option<&str> {
    let (scheme, _) = destination.split_once(':')?;
    let mut chars = scheme.chars();
    (chars.next()?.is_ascii_alphabetic()
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')))
    .then_some(scheme)
}

fn looks_like_web_host(host: &str) -> bool {
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2
        || !labels.iter().all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label.chars().all(|c| c.is_alphanumeric() || c == '-')
        })
    {
        return false;
    }
    let tld = labels[labels.len() - 1].to_lowercase();
    labels[0].eq_ignore_ascii_case("www") || WEB_TLDS.contains(&tld.as_str())
}

fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = text.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(pair, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog() -> WikilinkIndex {
        let ids: Vec<String> = ["Other", "docs/Guide", "docs/sub/Deep", "Top/Other", "A b"]
            .map(String::from)
            .into();
        WikilinkIndex::new(&ids)
    }

    fn resolve(destination: &str, from: &str) -> Option<String> {
        resolve_note_link(destination, from, &catalog())
    }

    #[test]
    fn a_schemeless_destination_resolves_as_a_note_path_from_the_current_folder() {
        for (destination, from, note) in [
            ("Other", "Start", "Other"),
            ("other.md", "Start", "Other"),
            ("./Other.md", "Start", "Other"),
            ("Guide.md", "docs/Start", "docs/Guide"),
            ("../Other", "docs/Guide", "Other"),
            ("sub/Deep.md#h", "docs/Guide", "docs/sub/Deep"),
            ("/docs/Guide.md", "Top/Other", "docs/Guide"),
            ("A%20b.md", "Start", "A b"),
            ("../../Other?x=1", "docs/sub/Deep", "Other"),
        ] {
            assert_eq!(
                resolve(destination, from).as_deref(),
                Some(note),
                "{destination:?} from {from:?}"
            );
        }
    }

    #[test]
    fn a_destination_naming_no_note_resolves_to_nothing() {
        for (destination, from) in [
            ("Missing.md", "Start"),
            ("#h", "Start"),
            ("", "Start"),
            ("../../../Other", "docs/Guide"),
            ("google.com", "Start"),
            ("setup.sh", "Start"),
            ("https://x", "Start"),
            ("tel:911", "Start"),
            ("//host/Other", "Start"),
            ("%zz", "Start"),
            ("%ff", "Start"),
            ("/", "Start"),
            ("..", "docs/Guide"),
        ] {
            assert_eq!(resolve(destination, from), None, "{destination:?}");
        }
    }

    #[test]
    fn case_picks_a_note_only_when_it_leaves_one_candidate() {
        let ids: Vec<String> = ["Notes", "NOTES"].map(String::from).into();
        let catalog = WikilinkIndex::new(&ids);
        assert_eq!(resolve_note_link("notes", "x", &catalog), None, "ambiguous");
        assert_eq!(
            resolve_note_link("NOTES", "x", &catalog).as_deref(),
            Some("NOTES")
        );
    }
}
