use futo_notes_editor::*;
#[path = "cross_block_selection/check.rs"]
mod check;
use check::{apply, checked, range, Input};

fn run(note: &str, a: usize, b: usize, input: Input) {
    let r = std::panic::catch_unwind(|| checked(note, a, b, input));
    let mut s = EditorSession::open(note);
    let disp = s.display_text();
    let raw = apply(&mut s, range(a, b), input);
    println!(
        "CASE {input:?} [{a},{b}) {:?} of {note:?}\n  checked={:?}\n  raw={:?} src={:?} sel={:?}",
        disp.get(a..b),
        r.as_ref().map(|x| x.clone()).map_err(|_| "PANIC"),
        raw.map(drop),
        s.source_text(),
        s.selection()
    );
    if raw_ok(&s, note) {
        let _ = s.undo(s.revision(), &mut |_| Ok(()));
        println!(
            "  undo src_ok={} sel={:?}",
            s.source_text() == note,
            s.selection()
        );
    }
}
fn raw_ok(s: &EditorSession, note: &str) -> bool {
    s.source_text() != note
}

#[test]
fn probe8() {
    for note in ["__日😀__ tail\r\n", "__日中__ tail\r\n", "a **b** c\nd\n"] {
    let s = EditorSession::open(note);
    let end = DisplayOffset(s.display_text().len());
    let sl = s.project(s.revision(), DisplayRange{start: DisplayOffset(0), end}).unwrap();
    println!("CORR {note:?} {:?}", sl.correspondence);
    }
}
#[test]
fn probe7() {
    let note = "a\n\nb\n```\nc\n\nd\n```\n```\ne\n```\n- e\n  f\n> g\n---\n# h\n| x |\n|---|\n| 1 |\n";
    let s = EditorSession::open(note);
    let end = DisplayOffset(s.display_text().len());
    let sl = s.project(s.revision(), DisplayRange{start: DisplayOffset(0), end}).unwrap();
    println!("TEXT {:?}", sl.text);
    for b in &sl.blocks { println!("BLK {:?} {:?} code={} h={} q={} div={} list={:?}", b.range, &sl.text[b.range.start.0..b.range.end.0], b.code, b.heading, b.quote_depth, b.divider, b.list); }
    for l in check::lines(note) { println!("LINE {:?}", l); }
}
#[test]
fn probe6() {
    for (note, sel, text) in [
        ("a _fox_ b\n```\ncode one\n```\n", "fox b\ncode o", "fox b\nczo"),
        ("a _fox_ b\nx\n```\ncode one\n```\n", "fox b\nx\ncode o", "fox b\nczo"),
        ("a _fox_ b\nx\n```\ncode\nmore\n```\n", "fox b\nx\ncode\nmo", "fox b\nz"),
        ("a _fox_ b\nx\n```\ncode\nmore\n```\n", "x\ncode\nmo", "z"),
        ("a b\nx\n```\ncode\nmore\n```\n", "b\nx\ncode\nmo", "b\nz"),
    ] {
        let a = EditorSession::open(note).display_text().find(sel).unwrap();
        let text: &'static str = Box::leak(text.to_string().into_boxed_str());
        run(note, a, a + sel.len(), Input::Os(text));
    }
}
#[test]
fn probe5() {
    let w = "teh **quick** brwon _fox_ jumsp\n- [ ] \n- [ ] ```\n      code\n      ```\n      Heading one\n\n";
    for (note, sel, text) in [
        (w, "fox jumsp\n\n```\ncode\n      He", "fox jumsp\n\n    czode    \n    "),
        (w, "fox jumsp\n\n```\ncode\n      He", "fox jumsp\n\nczode"),
        (w, "fox jumsp\n\n```\ncode", "fox jumsp\n\nczode"),
        (w, "fox jumsp\n\n```", "fox jumsp\n\nczode"),
        ("teh _fox_ jumsp\n- [ ] \n- [ ] ```\nafter", "fox jumsp\n\n```", "fox jumsp\n\nz"),
        ("teh _fox_ jumsp\n- [ ] \n- [ ] x\nafter", "fox jumsp\n\nx", "fox jumsp\n\nz"),
        ("teh _fox_ jumsp\n- [ ] x\nafter", "fox jumsp\nx", "fox jumsp\nz"),
        ("teh _fox_ jumsp\nx\nafter", "fox jumsp\nx", "fox jumsp\nz"),
    ] {
        let a = EditorSession::open(note).display_text().find(sel).unwrap();
        let text: &'static str = Box::leak(text.to_string().into_boxed_str());
        run(note, a, a + sel.len(), Input::Os(text));
    }
}
#[test]
fn probe4() {
    for (note, sel, text) in [
        ("a _fox_ b\nx\n```\ncode\n```\n", "fox b\nx\ncode", "fox b\nyz"),
        ("a _fox_ b\n- [ ] \n- [ ] x\n  code\n  ```\n  Head one\n", "fox b\n\nx\ncode\n  He", "fox b\n\n  cz  \n  "),
        ("a _fox_ b\n- [ ] \n- [ ] x\n  code\n  ```\n  Head one\n", "fox b\n\nx\ncode\n  He", "fox b\n\nczq"),
        ("a _fox_ b\nc\nd\n", " fox b\nc", " fox b\nz"),
        ("a _fox_ b\n```\ncode\n```\n", "fox b\ncode", "fox b\ncod"),
        ("a _fox_ b\n- [ ] x\n```\ncode\n```\n", "fox b\nx\ncode", "fox b\nx\nczode"),
    ] {
        let a = EditorSession::open(note).display_text().find(sel).unwrap();
        let text: &'static str = Box::leak(text.to_string().into_boxed_str());
        run(note, a, a + sel.len(), Input::Os(text));
    }
}
#[test]
fn probe3() {
    let note = "teh **quick** brwon _fox_ jumsp\n- [ ] \n- [ ] ```\n      code\n      ```\n      Heading one\n\n";
    let mut s = EditorSession::open(note);
    apply(&mut s, range(15,44), Input::Os(" fox jumsp\n\n    czode    \n    ")).unwrap();
    println!("W1 after display {:?}", s.display_text());
    let _ = checked(note, 15, 44, Input::Os(" fox jumsp\n\n    czode    \n    "));
}
#[test]
fn probe2() {
    let note = "teh **quick** brwon _fox_ jumsp\n- [ ] \n- [ ] ```\n      code\n      ```\n      Heading one\n\n";
    println!("W1 display {:?}", EditorSession::open(note).display_text());
    run(note, 15, 44, Input::Os(" fox jumsp\n\n    czode    \n    "));
    for (note, sel, text) in [("- **jumps** **lazy**s, coffee ~~world~~ hello", "jumps lazys, coffee world", "Monday items Monday cant"),
        ("fox it's recieve **hello**s **over** *project*", "fox it's recieve hellos over project", "jumps Monday brown items coffee naïve"),
        ("```\ncode\n```\n**Heading** one", "\nHeading", "Heading"),
        ("```\ncode\n```\n[Heading](u) one", "\nHeading", "Heading")] {
        let a = EditorSession::open(note).display_text().find(sel).unwrap();
        let text: &'static str = Box::leak(text.to_string().into_boxed_str());
        run(note, a, a + sel.len(), Input::Os(text));
    }
    run("```\ncode\n```\n**Heading** one", 4, 5, Input::Backspace);
    run("```\ncode\n```\n[Heading](u) one", 4, 5, Input::Backspace);
    let note = "3) three\n4) four\n\n```\nlet x = 1\ny = 2\nz = 3\n```";
    println!("R2 display {:?}", EditorSession::open(note).display_text());
    run(note, 4, 21, Input::Many);
}
#[test]
fn probe() {
    let rows: Vec<(&str, usize, usize, Input)> = vec![
        (
            "para\n\n```\nlet x = 1\ny = 2\nz = 3\n```\n\ntail\n",
            4,
            21,
            Input::Type("d"),
        ),
        (
            "para one\n\n```\nlet x = 1\ny = 2\n```\n\ntail\n",
            4,
            21,
            Input::Type("d"),
        ),
        (
            "```\nlet x = 1\ny = 2\n```\n\ntail\nmore\n",
            4,
            20,
            Input::Type("d"),
        ),
        (
            "```\nlet x = 1\ny = 2\n```\n\ntail",
            4,
            20,
            Input::Type("d"),
        ),
        (
            "```\nlet x = 1\ny = 2\n```\n\n```\nz = 3\nw = 4\n```\n",
            4,
            22,
            Input::Type("d"),
        ),
        ("```\ncode\n```\ntail", 4, 5, Input::Type("d")),
        (
            "> ```\n> let x = 1\n> y = 2\n> ```\n\ntail\n",
            4,
            14,
            Input::Type("d"),
        ),
        (
            "tail\n\n> ```\n> let x = 1\n> y = 2\n> z = 3\n> ```\n",
            2,
            12,
            Input::Type("d"),
        ),
        (
            "para\r\n\r\n```\r\nlet x\r\ny = 2\r\nz = 3\r\n```\r\n\r\ntail\r\n",
            2,
            16,
            Input::Type("d"),
        ),
        (
            "```\r\nlet x\r\ny = 2\r\n```\r\n\r\ntail\r\nmore\r\n",
            2,
            16,
            Input::Type("d"),
        ),
        (
            "para\r\n\r\n```\r\na\r\nb\r\nc\r\n```\r\n",
            5,
            12,
            Input::Type("d"),
        ),
        ("para\n\n```\ncode\n```\n", 5, 6, Input::Backspace),
        ("para\n\n```\ncode\n```", 5, 6, Input::Backspace),
        ("para\n\n```\ncode\nmore\n```\n", 5, 6, Input::Backspace),
        ("para\n\n> quote a\n> quote b\n", 5, 6, Input::Backspace),
        ("para\n\n    a\n    b\n", 4, 7, Input::Type("d")),
        (
            "## head *two*\n\n    indented code\n    more code\n",
            9,
            10,
            Input::Enter,
        ),
        (
            "# head\n\n    indented code\n    more code\n",
            5,
            8,
            Input::Backspace,
        ),
        ("- a\n- b\n\n```\nc\nd\n```\n", 4, 6, Input::Enter),
        (
            "```\nlet x = 1\ny = 2\n```\n\ntail\n",
            4,
            20,
            Input::Type("d"),
        ),
        ("```\ncode\n```\ntail\n", 4, 5, Input::Type("d")),
        ("para\n\n```\nab\n```\nnext line\n", 2, 7, Input::Type("d")),
        ("para\n\n```\nab\n```\n=\n", 2, 7, Input::Type("d")),
        ("para\n\n```\ncode\n```\ntail\n", 5, 6, Input::Backspace),
        (
            "- item\n  ```\n  c1\n  c2\n  ```\nplain text here\n",
            4,
            8,
            Input::Paste("pp"),
        ),
        (
            "Some text\n\n```\nlet value = 1\nreturn value\n```\n",
            5,
            24,
            Input::Os("e"),
        ),
        ("para\n\n```\ndeep\nx\n```\n", 4, 10, Input::Os("d")),
        ("```\nabc\n```\ndef", 1, 5, Input::Paste("- x")),
        (
            "> ```\n> code one\n> code two\n> ```\n\ntail text\n",
            3,
            19,
            Input::Paste("x\ny"),
        ),
    ];
    for (n, a, b, i) in rows {
        run(n, a, b, i);
    }
    let note = "```\ncode one\ncode two\n```\n\ntail text\n\n# Later heading\n\n- later item\n";
    for p in [
        "plain",
        "**b**",
        "x\ny",
        "# h",
        "- l1\n- l2",
        "> q",
        "1. one",
    ] {
        run(note, 3, 19, Input::Paste(p));
    }
}
