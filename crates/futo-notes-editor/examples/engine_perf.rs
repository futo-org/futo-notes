//! Engine-only synthetic timings; run with `just bench-editor-engine`.
//! Opening excludes destruction. Key timings exclude opening, display lookup,
//! rendering, persistence and sync; acceptance is an immediate no-op.
//! Compare release builds in ABBA order on the same CPU, with no concurrent builds.
#![allow(clippy::print_stdout)]

use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession, ParagraphKey};
use std::{hint::black_box, time::Instant};
fn range(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}
fn stats(label: &str, mut v: Vec<f64>) {
    v.sort_by(f64::total_cmp);
    println!(
        "{label}: median={:.3}ms p95={:.3}ms max={:.3}ms n={}",
        v[v.len() / 2],
        v[v.len() * 95 / 100],
        v[v.len() - 1],
        v.len()
    );
}
fn main() {
    for n in [1000, 20000, 100000] {
        for shape in ["plain", "rich", "numbered", "fence"] {
            let body: String = (0..n)
                .map(|i| match shape {
                    "rich" => format!("- **item {i}** [link](https://example.com) 😀 #tag\n"),
                    "numbered" => format!("{}. item {i}\n", i + 1),
                    _ => format!("item {i}\n"),
                })
                .collect();
            let source = if shape == "fence" {
                format!("```rust\n{body}```\n")
            } else {
                body
            };
            let mut opens = vec![];
            for _ in 0..7 {
                let t = Instant::now();
                let s = black_box(EditorSession::open(black_box(&source)));
                opens.push(t.elapsed().as_secs_f64() * 1000.);
                drop(s);
            }
            stats(&format!("{shape}/{n} open bytes={}", source.len()), opens);
            let mut s = EditorSession::open(&source);
            let display = s.display_text();
            let at = display.find(&format!("item {}", n / 2)).unwrap() + 5;
            let mut typing = vec![];
            let mut back = vec![];
            for _ in 0..100 {
                let t = Instant::now();
                black_box(
                    s.replace(s.revision(), range(at), "x", &mut |_| Ok(()))
                        .unwrap(),
                );
                typing.push(t.elapsed().as_secs_f64() * 1000.);
                let t = Instant::now();
                black_box(
                    s.paragraph_key(
                        s.revision(),
                        range(at + 1),
                        ParagraphKey::Backspace,
                        &mut |_| Ok(()),
                    )
                    .unwrap(),
                );
                back.push(t.elapsed().as_secs_f64() * 1000.);
            }
            assert_eq!(s.source_text(), source);
            stats(&format!("{shape}/{n} type"), typing);
            stats(&format!("{shape}/{n} backspace"), back);
            let mut enters = vec![];
            for _ in 0..7 {
                let mut s = EditorSession::open(&source);
                let t = Instant::now();
                black_box(
                    s.paragraph_key(
                        s.revision(),
                        range(at),
                        ParagraphKey::Enter,
                        &mut |_| Ok(()),
                    )
                    .unwrap(),
                );
                enters.push(t.elapsed().as_secs_f64() * 1000.);
            }
            stats(&format!("{shape}/{n} enter"), enters);
        }
    }
    for n in [2000, 50000, 200000] {
        let source = "word ".repeat(n / 5);
        let mut s = EditorSession::open(&source);
        let mut times = vec![];
        for _ in 0..100 {
            let t = Instant::now();
            black_box(
                s.replace(s.revision(), range(n / 2), "x", &mut |_| Ok(()))
                    .unwrap(),
            );
            times.push(t.elapsed().as_secs_f64() * 1000.);
            s.paragraph_key(
                s.revision(),
                range(n / 2 + 1),
                ParagraphKey::Backspace,
                &mut |_| Ok(()),
            )
            .unwrap();
        }
        assert_eq!(s.source_text(), source);
        stats(&format!("single-line/{n} type"), times);
    }
}
