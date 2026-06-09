import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("$lib/platform");

import { testFS } from "$lib/platform";
import {
  makePreview,
  convertTxtToMd,
} from "./notesIndex";

beforeEach(() => {
  testFS._reset();
});

afterAll(() => {
  testFS._cleanup();
});

// ── makePreview ───────────────────────────────────────────────────────

describe("makePreview", () => {
  it("returns short content as-is", () => {
    expect(makePreview("hello world")).toBe("hello world");
  });

  it("replaces newlines with spaces", () => {
    expect(makePreview("line one\nline two\nline three")).toBe(
      "line one line two line three",
    );
  });

  it("truncates at 100 characters", () => {
    const long = "A".repeat(150);
    const preview = makePreview(long);
    expect(preview).toHaveLength(100);
    expect(preview).toBe("A".repeat(100));
  });

  it("returns empty string for empty content", () => {
    expect(makePreview("")).toBe("");
  });

  it("handles content exactly 100 chars", () => {
    const exact = "B".repeat(100);
    expect(makePreview(exact)).toBe(exact);
  });

  // ── F14 regression: parity with Rust make_preview ──────────────────────
  // The optimistic-cache hot path used to drift from the Rust source of truth
  // (crates/futo-notes-model/src/crud.rs make_preview): TS skipped CRLF/tab
  // collapsing + trimming and truncated BEFORE collapsing. Sidebar previews
  // differed before vs after a rescan/sync. These cases pin TS to Rust exactly.

  it("collapses CRLF to a single space (not two)", () => {
    expect(makePreview("line one\r\nline two")).toBe("line one line two");
  });

  it("collapses tabs to spaces", () => {
    expect(makePreview("col1\tcol2\tcol3")).toBe("col1 col2 col3");
  });

  it("trims leading and trailing whitespace", () => {
    expect(makePreview("   padded text   ")).toBe("padded text");
  });

  it("trims leading newlines before truncating", () => {
    // Rust trims after collapsing, so the leading blank line is gone and the
    // 100-char budget applies to the real content — not consumed by padding.
    expect(makePreview("\n\nactual content")).toBe("actual content");
  });

  it("truncates AFTER collapsing/trimming (100 visible chars)", () => {
    // 60 'A', a newline, then 60 'B'. After collapse: 60 A + space + 60 B = 121
    // chars; take 100 → 60 A + space + 39 B. The old code truncated the raw
    // string at 100 (60 A + \n + 39 B) THEN replaced \n, producing a different
    // string the moment a rescan recomputed it.
    const content = "A".repeat(60) + "\n" + "B".repeat(60);
    const expected = "A".repeat(60) + " " + "B".repeat(39);
    expect(makePreview(content)).toBe(expected);
    expect(makePreview(content)).toHaveLength(100);
  });

  it("counts unicode by code point (chars), matching Rust .chars().take()", () => {
    // 100 emoji code points → take 100. JS String.slice counts UTF-16 units,
    // which would cut an astral pair in half; Rust counts scalar values.
    const emoji = "🎉".repeat(120);
    const preview = makePreview(emoji);
    expect([...preview]).toHaveLength(100);
    expect(preview).toBe("🎉".repeat(100));
  });

  it("returns empty string for whitespace-only content", () => {
    expect(makePreview("   \n\t  ")).toBe("");
  });
});

// ── convertTxtToMd ───────────────────────────────────────────────────

describe("convertTxtToMd", () => {
  it("renames .txt to .md when no collision", async () => {
    // Write a .txt file using writeAppData (which doesn't add .md extension)
    await testFS.writeAppData("my-note.txt", "text content");

    await convertTxtToMd(testFS);

    // Should now have .md file
    const files = await testFS.listAppData(".");
    expect(files).toContain("my-note.md");
    expect(files).not.toContain("my-note.txt");

    // Content should be preserved
    const content = await testFS.readAppData("my-note.md");
    expect(content).toBe("text content");
  });

  it("handles collision: x.txt + x.md -> x (imported).md", async () => {
    await testFS.writeAppData("notes.txt", "txt content");
    await testFS.writeNote("notes", "md content"); // creates notes.md

    await convertTxtToMd(testFS);

    const files = await testFS.listAppData(".");
    expect(files).not.toContain("notes.txt");
    expect(files).toContain("notes.md");
    expect(files).toContain("notes (imported).md");

    // Original .md should be untouched
    const mdContent = await testFS.readNote("notes");
    expect(mdContent).toBe("md content");

    // Imported file should have the txt content
    const importedContent = await testFS.readAppData("notes (imported).md");
    expect(importedContent).toBe("txt content");
  });

  it("is a no-op when there are no .txt files", async () => {
    await testFS.writeNote("existing", "content");

    await convertTxtToMd(testFS);

    const files = await testFS.listAppData(".");
    expect(files).toContain("existing.md");
    // After the migration runs once we also write a sentinel file so the
    // next session can short-circuit without another full-dir scan.
    expect(files).toContain(".txt-migration-done");
  });

  it("writes a sentinel that short-circuits subsequent calls", async () => {
    // First run: writes the sentinel
    await convertTxtToMd(testFS);
    const afterFirst = await testFS.listAppData(".");
    expect(afterFirst).toContain(".txt-migration-done");

    // Second run should see the sentinel and skip the dir scan entirely.
    // We verify by planting a .txt file *after* the sentinel is written —
    // if the second call still scans, it would migrate this file; the
    // sentinel guard must keep it untouched.
    await testFS.writeAppData("late.txt", "late content");
    await convertTxtToMd(testFS);
    const afterSecond = await testFS.listAppData(".");
    expect(afterSecond).toContain("late.txt");
    expect(afterSecond).not.toContain("late.md");
  });
});
