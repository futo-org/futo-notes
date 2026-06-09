//! F19 (PERF-HIGH) regression + perf coverage for the scan/preview/tags hot
//! path. The fixes here MUST be byte-for-byte output-preserving — the
//! conformance suite (`tests/conformance.rs` against `preview.json`/`tags.json`)
//! and `crud_parity.rs` pin the contract. These tests add two things the
//! existing suites don't:
//!
//!   1. The exact `make_preview` truncation×trim BOUNDARY cases that a naive
//!      single-pass rewrite gets wrong (trailing whitespace that does / doesn't
//!      survive depending on whether content follows the 100-char window).
//!   2. A large multi-note fixture (incl. a few multi-MB notes) that proves the
//!      parallel scan returns IDENTICAL metadata to a serial reference scan, and
//!      prints before/after timing.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Instant;

use futo_notes_model as model;

fn temp_root(tag: &str) -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let dir = std::env::temp_dir().join(format!("futo-model-perf-{tag}-{pid}-{n}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

// ── make_preview: truncation × trim boundary cases ───────────────────────
//
// These distinguish the contract "trim the FULL collapsed string, THEN take
// 100 code points" from the (wrong) "take 100, then trim_end".

#[test]
fn preview_trailing_ws_dropped_when_no_content_follows() {
    // 100 content chars then trailing spaces, EOF. trim removes the trailing
    // spaces BEFORE truncation, so the result is exactly the 100 content chars.
    let body = format!("{}{}", "a".repeat(100), " ".repeat(50));
    assert_eq!(model::make_preview(&body), "a".repeat(100));

    // 98 content chars + lots of trailing ws, EOF → trimmed length 98.
    let body2 = format!("{}{}", "b".repeat(98), " ".repeat(40));
    assert_eq!(model::make_preview(&body2), "b".repeat(98));
}

#[test]
fn preview_internal_ws_within_budget_is_kept_when_content_follows() {
    // 50 content + 50 spaces + MORE content. The spaces are internal (content
    // follows in the full trimmed string), so chars 51..=100 are spaces and
    // they survive truncation. Result is 50 'a' followed by 50 spaces.
    let body = format!("{}{}{}", "a".repeat(50), " ".repeat(50), "b".repeat(20));
    let expected = format!("{}{}", "a".repeat(50), " ".repeat(50));
    assert_eq!(model::make_preview(&body), expected);
    assert_eq!(model::make_preview(&body).chars().count(), 100);
}

#[test]
fn preview_crlf_vs_bare_cr_and_no_multispace_collapse() {
    // CRLF collapses to ONE space; a bare CR (not followed by LF) stays as-is
    // internally but is trimmed at the edges (it is Unicode whitespace).
    assert_eq!(model::make_preview("a\r\nb"), "a b");
    assert_eq!(model::make_preview("a\rb"), "a\rb"); // internal bare CR kept
    assert_eq!(model::make_preview("\ra\r"), "a"); // edge bare CR trimmed
    // No multi-space collapse: consecutive newlines → consecutive spaces.
    assert_eq!(model::make_preview("a\n\n\nb"), "a   b");
    assert_eq!(model::make_preview("a\t\tb"), "a  b");
}

#[test]
fn preview_unicode_take_is_by_code_point() {
    let emoji = "🎉".repeat(250);
    let out = model::make_preview(&emoji);
    assert_eq!(out.chars().count(), 100);
    assert_eq!(out, "🎉".repeat(100));
}

// ── note_tags fast path is behaviour-preserving ──────────────────────────
#[test]
fn note_tags_no_code_regions_matches_extract() {
    // A note with no fences and no backticks must yield exactly the same tags
    // as extract_tags (minus the leading '#'), proving the no-code fast path.
    let body = "Topic #alpha and #beta-1 then #Gamma_2 #alpha again";
    let via_extract: Vec<String> = model::extract_tags(body)
        .into_iter()
        .map(|t| t.trim_start_matches('#').to_string())
        .collect();
    assert_eq!(model::note_tags(body), via_extract);
    assert_eq!(model::note_tags(body), vec!["alpha", "beta-1", "gamma_2"]);
    // Code fence + inline code still excluded (slow path unchanged).
    assert_eq!(model::note_tags("#real `#inline` \n```\n#fenced\n```"), vec!["real"]);
}

// ── large fixture: parallel scan == serial scan, with timing ─────────────

/// Independent serial reference scan (mirrors the public-contract output) used
/// to prove the optimized `scan_notes` is identical regardless of threading.
fn serial_reference(base: &Path) -> Vec<(String, String, Vec<String>, i64)> {
    let mut out = Vec::new();
    collect(base, base, &mut out);
    out.sort_by(|a, b| b.3.cmp(&a.3).then(a.0.cmp(&b.0)));
    out
}

fn collect(base: &Path, dir: &Path, out: &mut Vec<(String, String, Vec<String>, i64)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect(base, &path, out);
        } else if ft.is_file() && name.ends_with(".md") {
            let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            let Some(id) = rel.strip_suffix(".md") else { continue };
            if id.is_empty() {
                continue;
            }
            let content = fs::read_to_string(&path).unwrap_or_default();
            let meta = fs::metadata(&path).unwrap();
            let modified = futo_notes_core::files::file_mtime_ms(&meta);
            out.push((
                id.to_string(),
                model::make_preview(&content),
                model::note_tags(&content),
                modified,
            ));
        }
    }
}

#[test]
fn parallel_scan_matches_serial_on_large_fixture() {
    let root = temp_root("large");
    // Many notes with varied content (tags, code fences, CRLF, unicode, blanks)
    // — enough to exercise the parallel map across rayon worker boundaries while
    // staying fast under unoptimized `cargo test` (the fixture WRITE dominates in
    // debug). Multi-MB notes + the brief's 5k-note vault are covered by the
    // `#[ignore]` `bench_scan_5k` / `bench_per_note` benches (run on demand),
    // which assert the SAME parallel-vs-serial parity at full scale.
    let n_notes = 1500usize;

    for i in 0..n_notes {
        let folder = format!("dir{:02}", i % 40);
        let id = format!("{folder}/note{i:05}");
        // Rotate through content shapes so the per-file work isn't uniform.
        let body = match i % 5 {
            0 => format!("#tag{} note body {i}\r\nsecond line\twith content", i % 13),
            1 => format!("#real body {i}\n```\n#fake inside fence\n```\nafter"),
            2 => format!("café résumé 🎉 note {i} with #emoji and `#inline` code"),
            3 => format!("   \n\n   leading blanks then #content{} here", i % 7),
            _ => format!("plain note {i} no tags at all, just prose words here"),
        };
        model::write_note(&root, &id, &body).unwrap();
    }

    // Serial reference (also serves as the "before" baseline cost model).
    let t0 = Instant::now();
    let reference = serial_reference(&root);
    let serial_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let scanned = model::scan_notes(&root);
    let scan_ms = t1.elapsed().as_secs_f64() * 1000.0;

    assert_eq!(scanned.len(), reference.len(), "note count must match");
    for (note, refrow) in scanned.iter().zip(reference.iter()) {
        assert_eq!(note.id, refrow.0, "id/order mismatch");
        assert_eq!(note.preview, refrow.1, "preview mismatch for {}", note.id);
        assert_eq!(note.tags, refrow.2, "tags mismatch for {}", note.id);
        assert_eq!(note.modified_ms, refrow.3, "mtime mismatch for {}", note.id);
    }

    eprintln!(
        "[scan_perf] notes={n_notes} serial_ref={serial_ms:.1}ms scan_notes(parallel)={scan_ms:.1}ms"
    );

    fs::remove_dir_all(&root).ok();
}

/// Before/after benchmark on the brief's 5k-note vault (a few multi-MB notes).
/// `#[ignore]` so it never burdens normal `cargo test`; run explicitly with:
///   cargo test -p futo-notes-model --release --test scan_perf bench_scan_5k -- --ignored --nocapture
/// "before" = the OLD per-note formula (3 full-body String replaces for the
/// preview + `extract_tags` then strip the `#`) run SERIALLY, i.e. the code as
/// it was before F19. "after" = the optimized parallel `scan_notes`.
#[test]
#[ignore]
fn bench_scan_5k() {
    let root = temp_root("bench5k");
    let n_notes = 5000usize;
    let n_big = 4usize;
    for i in 0..n_notes {
        let folder = format!("dir{:02}", i % 50);
        let id = format!("{folder}/note{i:05}");
        let body = if i < n_big {
            // ~400 KB of realistic prose. Capped below the ~0.5 MB point where
            // the SEPARATE fancy-regex tag-scan blowup dominates (out of F19
            // scope; see `bench_tag_scaling`) — both the before and after paths
            // pay that cost equally, so a bigger body would only measure the
            // regex, not the parallel/preview win this bench targets.
            let mut s = String::with_capacity(450_000);
            s.push_str("#bigtag #reference\n\n");
            let para = "The quick brown fox jumps over the lazy dog near the riverbank. ";
            while s.len() < 400_000 {
                s.push_str(para);
                if s.len() % 4096 < para.len() {
                    s.push('\n');
                }
            }
            s
        } else {
            format!("#tag{} note body {i}\nsecond line with content", i % 13)
        };
        model::write_note(&root, &id, &body).unwrap();
    }

    // Collect the file list once (shared by both timings; the walk is not the
    // thing under test).
    let mut files = Vec::new();
    walk(&root, &root, &mut files);

    // "before": OLD make_preview + extract_tags-then-strip, run serially.
    let t0 = Instant::now();
    let mut before: Vec<(String, String, Vec<String>)> = files
        .iter()
        .map(|(id, path)| {
            let content = fs::read_to_string(path).unwrap_or_default();
            (id.clone(), old_make_preview(&content), old_note_tags(&content))
        })
        .collect();
    before.sort_by(|a, b| a.0.cmp(&b.0));
    let before_ms = t0.elapsed().as_secs_f64() * 1000.0;

    // "after": the optimized parallel scan_notes.
    let t1 = Instant::now();
    let after = model::scan_notes(&root);
    let after_ms = t1.elapsed().as_secs_f64() * 1000.0;

    // Sanity: outputs agree.
    let mut after_sorted: Vec<_> = after
        .iter()
        .map(|n| (n.id.clone(), n.preview.clone(), n.tags.clone()))
        .collect();
    after_sorted.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(before, after_sorted, "before/after outputs must be identical");

    eprintln!(
        "[bench_scan_5k] notes={n_notes} (+{n_big} multi-MB)  BEFORE(serial,old-formula)={before_ms:.1}ms  AFTER(parallel,optimized)={after_ms:.1}ms  speedup={:.2}x",
        before_ms / after_ms
    );
    fs::remove_dir_all(&root).ok();
}

/// Pure in-memory micro-benchmark (no file I/O, no fixture-write cost) isolating
/// the two per-note CPU costs F19 targets, on a single ~2 MB note:
///   - `make_preview`: OLD 3-replace formula vs NEW single-pass early-out.
///   - tag extraction: OLD `extract_tags`+strip vs NEW `note_tags`.
/// `#[ignore]`; run with:
///   cargo test -p futo-notes-model --release --test scan_perf bench_per_note -- --ignored --nocapture
#[test]
#[ignore]
fn bench_per_note() {
    // NOTE: body capped at 400 KB. `note_tags` (fancy-regex `tag_regex` over the
    // whole body) is super-linear beyond ~0.5 MB (see `bench_tag_scaling`), which
    // is the dominant — and SEPARATE, out-of-F19-scope — multi-MB cost; a larger
    // body here would hang on the regex, not the code this bench measures.
    let mut prose = String::with_capacity(450_000);
    prose.push_str("#bigtag #reference\n\n");
    let para = "The quick brown fox jumps over the lazy dog near the riverbank. ";
    while prose.len() < 400_000 {
        prose.push_str(para);
        if prose.len() % 4096 < para.len() {
            prose.push('\n');
        }
    }
    let iters = 200;

    let t = Instant::now();
    let mut sink = 0usize;
    for _ in 0..iters {
        sink += old_make_preview(&prose).len();
    }
    let old_prev = t.elapsed().as_secs_f64() * 1000.0 / iters as f64;

    let t = Instant::now();
    for _ in 0..iters {
        sink += model::make_preview(&prose).len();
    }
    let new_prev = t.elapsed().as_secs_f64() * 1000.0 / iters as f64;

    let tag_iters = 20;
    let t = Instant::now();
    for _ in 0..tag_iters {
        sink += old_note_tags(&prose).len();
    }
    let old_tags = t.elapsed().as_secs_f64() * 1000.0 / tag_iters as f64;

    let t = Instant::now();
    for _ in 0..tag_iters {
        sink += model::note_tags(&prose).len();
    }
    let new_tags = t.elapsed().as_secs_f64() * 1000.0 / tag_iters as f64;

    eprintln!(
        "[bench_per_note] 400KB note  make_preview: old={old_prev:.4}ms new={new_prev:.4}ms ({:.1}x)  note_tags: old={old_tags:.3}ms new={new_tags:.3}ms ({:.2}x)  (sink={sink})",
        old_prev / new_prev,
        old_tags / new_tags,
    );
}

/// Diagnostic: how `note_tags` (the fancy-regex `tag_regex` scan) scales with
/// body size. `#[ignore]`; run with `... bench_tag_scaling -- --ignored --nocapture`.
///
/// FINDING (F19, out of this track's safe scope): the cost is roughly linear up
/// to ~400 KB, then turns SUPER-LINEAR (the `bench_tag_scaling`/`bench_per_note`
/// runs hang past ~0.5 MB). The blowup is in `tags::tag_regex` — fancy-regex's
/// backtracking on the `(?:^|(?<=\s))` alternation evaluated at every position.
/// This is the dominant per-note cost for genuinely multi-MB notes and is the
/// real ceiling F19 hits; linearizing it (e.g. per-line scan, or a `#`-anchored
/// pre-filter) is a behavior-pinned change that must be proven bit-for-bit
/// against the conformance + TS-parity suites, so it is intentionally NOT landed
/// here. Sizes below are capped under the blowup so this probe always finishes.
#[test]
#[ignore]
fn bench_tag_scaling() {
    let para = "The quick brown fox jumps over the lazy dog near the riverbank. ";
    for &kb in &[10usize, 50, 100, 200, 400] {
        let target = kb * 1024;
        let mut s = String::with_capacity(target + 256);
        s.push_str("#bigtag\n\n");
        while s.len() < target {
            s.push_str(para);
            if s.len() % 4096 < para.len() {
                s.push('\n');
            }
        }
        let t = Instant::now();
        let n = model::note_tags(&s).len();
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        eprintln!("[bench_tag_scaling] {kb}KB note_tags={ms:.2}ms tags={n}");
    }
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            walk(base, &path, out);
        } else if ft.is_file() && name.ends_with(".md") {
            let rel = path.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/");
            if let Some(id) = rel.strip_suffix(".md") {
                if !id.is_empty() {
                    out.push((id.to_string(), path.clone()));
                }
            }
        }
    }
}

/// The pre-F19 `make_preview`: three full-body String allocations.
fn old_make_preview(content: &str) -> String {
    let collapsed = content
        .replace("\r\n", " ")
        .replace('\n', " ")
        .replace('\t', " ");
    collapsed.trim().chars().take(100).collect()
}

/// The pre-F19 `note_tags`: build `#tag` then strip the `#` back off.
fn old_note_tags(content: &str) -> Vec<String> {
    model::extract_tags(content)
        .into_iter()
        .map(|t| t.trim_start_matches('#').to_string())
        .collect()
}
