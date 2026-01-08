// Editor setup - bundled by esbuild and inlined into the WebView
// This file contains the CodeMirror editor initialization and markdown transformation logic

// Global error handler to catch any uncaught errors
window.onerror = function(message, source, lineno, colno, error) {
  window.ReactNativeWebView.postMessage(JSON.stringify({
    type: "error",
    message: message,
    source: source,
    line: lineno,
    col: colno,
    stack: error ? error.stack : "no stack"
  }));
  return true;
};

const {
  EditorView,
  Decoration,
  ViewPlugin,
  WidgetType,
  keymap,
  history,
  historyKeymap,
  defaultKeymap,
  syntaxTree,
  ensureSyntaxTree,
  markdown,
  GFM,
} = window.CM;

let view;
let isUpdatingFromRN = false;

function getCursorLines(view) {
  const lines = new Set();
  if (!view.hasFocus) return lines;
  for (const range of view.state.selection.ranges) {
    const startLine = view.state.doc.lineAt(range.from).number;
    const endLine = view.state.doc.lineAt(range.to).number;
    for (let i = startLine; i <= endLine; i++) {
      lines.add(i);
    }
  }
  return lines;
}

function isOnCursorLine(pos, view, cursorLines) {
  const line = view.state.doc.lineAt(pos);
  return cursorLines.has(line.number);
}

function isCursorInsideElement(view, from, to) {
  if (!view.hasFocus) return false;
  for (const range of view.state.selection.ranges) {
    if (range.from >= from && range.from < to) return true;
    if (range.to > from && range.to < to) return true;
  }
  return false;
}

function isCursorAtEnd(view, pos) {
  if (!view.hasFocus) return false;
  for (const range of view.state.selection.ranges) {
    if (range.from === pos) return true;
  }
  return false;
}

const hideMarkdownPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.buildDecorations(view);
      this.selectionDebounceTimer = null;
    }

    update(update) {
      // Note: viewportChanged intentionally excluded - rebuilding on scroll causes jump issues
      if (update.docChanged || update.focusChanged) {
        // Document changes and focus changes: rebuild immediately
        clearTimeout(this.selectionDebounceTimer);
        this.decorations = this.buildDecorations(update.view);
      } else if (update.selectionSet) {
        // Selection-only changes: debounce to reduce CPU work during cursor movement
        clearTimeout(this.selectionDebounceTimer);
        this.selectionDebounceTimer = setTimeout(() => {
          this.decorations = this.buildDecorations(update.view);
          // Request a re-render with updated decorations
          update.view.requestMeasure();
        }, 50);
      }
    }

    buildDecorations(view) {
      try {
        const decorations = [];
        const cursorLines = getCursorLines(view);
        const tree =
          ensureSyntaxTree(view.state, view.state.doc.length, 100) ||
          syntaxTree(view.state);
        if (tree.length === 0) return Decoration.none;

        tree.iterate({
          enter: (node) => {
            const { from, to } = node;
            const type = node.type.name;
            const isBlockElement =
              type.startsWith("ATXHeading") ||
              type.startsWith("SetextHeading") ||
              type === "ListItem" ||
              type === "Task" ||
              type === "FencedCode" ||
              type === "CodeBlock" ||
              type === "HorizontalRule" ||
              type === "Table";

            if (isBlockElement && isOnCursorLine(from, view, cursorLines))
              return;

            if (type.startsWith("ATXHeading")) {
              const level = type.charAt(type.length - 1);
              const headerMark = node.node.getChild("HeaderMark");
              if (headerMark) {
                decorations.push({
                  from: headerMark.from,
                  to: headerMark.to + 1,
                  value: Decoration.replace({}),
                });
              }
              const contentFrom = headerMark ? headerMark.to + 1 : from;
              if (contentFrom < to) {
                decorations.push({
                  from: contentFrom,
                  to: to,
                  value: Decoration.mark({ class: "cm-md-h" + level }),
                });
              }
            } else if (type === "SetextHeading1" || type === "SetextHeading2") {
              const level = type === "SetextHeading1" ? "1" : "2";
              // Setext headings have the text on one line and underline on the next
              const setextMark =
                node.node.getChild("SetextHeading1Mark") ||
                node.node.getChild("SetextHeading2Mark");
              if (setextMark) {
                // Hide the underline (=== or ---)
                decorations.push({
                  from: setextMark.from,
                  to: setextMark.to,
                  value: Decoration.replace({}),
                });
              }
              // Apply heading style to the content
              const contentTo = setextMark ? setextMark.from : to;
              if (from < contentTo) {
                decorations.push({
                  from: from,
                  to: contentTo,
                  value: Decoration.mark({ class: "cm-md-h" + level }),
                });
              }
            } else if (type === "Emphasis") {
              const marks = node.node.getChildren("EmphasisMark");
              if (marks.length < 2) return;
              if (isCursorInsideElement(view, from, to)) return;

              const closingMark = marks[marks.length - 1];
              decorations.push({
                from: marks[0].to,
                to: closingMark.from,
                value: Decoration.mark({ class: "cm-md-emphasis" }),
              });
              if (!isCursorAtEnd(view, to)) {
                marks.forEach((mark) => {
                  decorations.push({
                    from: mark.from,
                    to: mark.to,
                    value: Decoration.replace({}),
                  });
                });
              }
            } else if (type === "StrongEmphasis") {
              const marks = node.node.getChildren("EmphasisMark");
              if (marks.length < 2) return;
              if (isCursorInsideElement(view, from, to)) return;

              const closingMark = marks[marks.length - 1];
              decorations.push({
                from: marks[0].to,
                to: closingMark.from,
                value: Decoration.mark({ class: "cm-md-strong" }),
              });
              if (!isCursorAtEnd(view, to)) {
                marks.forEach((mark) => {
                  decorations.push({
                    from: mark.from,
                    to: mark.to,
                    value: Decoration.replace({}),
                  });
                });
              }
            } else if (type === "Strikethrough") {
              const marks = node.node.getChildren("StrikethroughMark");
              if (marks.length < 2) return;
              if (isCursorInsideElement(view, from, to)) return;

              const closingMark = marks[marks.length - 1];
              decorations.push({
                from: marks[0].to,
                to: closingMark.from,
                value: Decoration.mark({ class: "cm-md-strikethrough" }),
              });
              if (!isCursorAtEnd(view, to)) {
                marks.forEach((mark) => {
                  decorations.push({
                    from: mark.from,
                    to: mark.to,
                    value: Decoration.replace({}),
                  });
                });
              }
            } else if (type === "InlineCode") {
              const marks = node.node.getChildren("CodeMark");
              if (marks.length < 2) return;
              if (isCursorInsideElement(view, from, to)) return;

              const closingMark = marks[marks.length - 1];
              decorations.push({
                from: marks[0].to,
                to: closingMark.from,
                value: Decoration.mark({ class: "cm-md-code" }),
              });
              if (!isCursorAtEnd(view, to)) {
                marks.forEach((mark) => {
                  decorations.push({
                    from: mark.from,
                    to: mark.to,
                    value: Decoration.replace({}),
                  });
                });
              }
            } else if (type === "Link") {
              if (isCursorInsideElement(view, from, to)) return;

              const linkMarks = node.node.getChildren("LinkMark");
              const url = node.node.getChild("URL");

              // Link text is between first [ and first ]
              // LinkMarks are: [, ], (, )
              if (linkMarks.length >= 2) {
                const textFrom = linkMarks[0].to; // after [
                const textTo = linkMarks[1].from; // before ]
                if (textTo > textFrom) {
                  decorations.push({
                    from: textFrom,
                    to: textTo,
                    value: Decoration.mark({ class: "cm-md-link" }),
                  });
                }
              }
              if (!isCursorAtEnd(view, to)) {
                linkMarks.forEach((mark) => {
                  decorations.push({
                    from: mark.from,
                    to: mark.to,
                    value: Decoration.replace({}),
                  });
                });
                if (url) {
                  decorations.push({
                    from: url.from - 1,
                    to: url.to + 1,
                    value: Decoration.replace({}),
                  });
                }
              }
            } else if (type === "Image") {
              if (isCursorInsideElement(view, from, to)) return;

              const linkMarks = node.node.getChildren("LinkMark");
              const url = node.node.getChild("URL");

              // Image: ![alt text](url)
              // Extract alt text and URL to render actual image
              let altText = "";

              // Find alt text between [ and ]
              for (let i = 0; i < linkMarks.length - 1; i++) {
                const mark = linkMarks[i];
                const nextMark = linkMarks[i + 1];
                const markText = view.state.doc.sliceString(mark.from, mark.to);
                const nextMarkText = view.state.doc.sliceString(
                  nextMark.from,
                  nextMark.to
                );

                if (markText === "[" && nextMarkText === "]") {
                  altText = view.state.doc.sliceString(mark.to, nextMark.from);
                  break;
                }
              }

              // Get the URL
              const imageUrl = url
                ? view.state.doc.sliceString(url.from, url.to)
                : "";

              // Only render image if we have a URL and cursor is not at the end
              if (imageUrl && !isCursorAtEnd(view, to)) {
                // Replace entire image markdown with actual image widget
                decorations.push({
                  from: from,
                  to: to,
                  value: Decoration.replace({
                    widget: new (class extends WidgetType {
                      constructor() {
                        super();
                        this.url = imageUrl;
                        this.alt = altText;
                      }
                      toDOM() {
                        const container = document.createElement("span");
                        container.className = "cm-md-image-container";
                        container.style.cssText = `
                      display: block;
                      margin: 8px 0;
                    `;

                        const img = document.createElement("img");
                        img.src = this.url;
                        img.alt = this.alt;
                        img.title = this.alt;
                        img.style.cssText = `
                      max-width: 100%;
                      height: auto;
                      border-radius: 8px;
                    `;

                        // Show alt text as fallback while loading or on error
                        img.onerror = () => {
                          container.innerHTML = "";
                          const fallback = document.createElement("span");
                          fallback.className = "cm-md-image-error";
                          fallback.textContent = "[Image: " + this.alt + "]";
                          fallback.style.cssText = `
                        color: #888;
                        font-style: italic;
                      `;
                          container.appendChild(fallback);
                        };

                        container.appendChild(img);
                        return container;
                      }
                      eq(other) {
                        return this.url === other.url && this.alt === other.alt;
                      }
                    })(),
                  }),
                });
              }
            } else if (type === "Autolink" || type === "URL") {
              // Autolinks like <https://example.com> or bare URLs
              decorations.push({
                from: from,
                to: to,
                value: Decoration.mark({ class: "cm-md-link" }),
              });
            } else if (type === "Blockquote") {
              // Only process top-level blockquotes - nested ones are handled by parent
              const parent = node.node.parent;
              if (parent && parent.type.name === "Blockquote") {
                return; // Skip - handled by parent blockquote
              }

              // Don't process blockquotes on cursor line to show raw markdown
              if (isOnCursorLine(from, view, cursorLines)) {
                return false; // Skip children
              }

              // Collect all QuoteMarks and track count per line for nesting level
              const quoteMarksByLine = new Map(); // lineNumber -> count
              const allQuoteMarks = [];

              function collectQuoteMarks(n) {
                let child = n.firstChild;
                while (child) {
                  if (child.type.name === "QuoteMark") {
                    allQuoteMarks.push({ from: child.from, to: child.to });
                    const lineNum = view.state.doc.lineAt(child.from).number;
                    quoteMarksByLine.set(
                      lineNum,
                      (quoteMarksByLine.get(lineNum) || 0) + 1
                    );
                  }
                  // Recursively traverse all children to find QuoteMarks
                  collectQuoteMarks(child);
                  child = child.nextSibling;
                }
              }
              collectQuoteMarks(node.node);

              // Hide all QuoteMarks
              for (const mark of allQuoteMarks) {
                if (!isOnCursorLine(mark.from, view, cursorLines)) {
                  const lineEnd = view.state.doc.lineAt(mark.from).to;
                  const hideEnd = Math.min(mark.to + 1, lineEnd);
                  if (hideEnd > mark.from) {
                    decorations.push({
                      from: mark.from,
                      to: hideEnd,
                      value: Decoration.replace({}),
                    });
                  }
                }
              }

              // Apply blockquote line decorations with nesting level
              const startLine = view.state.doc.lineAt(from).number;
              const endLine = view.state.doc.lineAt(to).number;
              for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
                const line = view.state.doc.line(lineNum);
                const depth = quoteMarksByLine.get(lineNum) || 1;
                const depthClass =
                  depth > 1 ? ` cm-md-blockquote-${Math.min(depth, 3)}` : "";
                decorations.push({
                  from: line.from,
                  to: line.from,
                  value: Decoration.line({
                    class: `cm-md-blockquote${depthClass}`,
                  }),
                });
              }
              // Don't return false - let children (lists, emphasis, code, etc.) be processed
            } else if (type === "QuoteMark") {
              // Skip - handled by Blockquote
            } else if (type === "OrderedList") {
              // Only process top-level ordered lists
              const parent = node.node.parent;
              if (
                parent &&
                (parent.type.name === "ListItem" ||
                  parent.type.name === "OrderedList")
              ) {
                return; // Skip nested - handled by parent
              }

              // Process ordered list with continuous numbering through nesting
              let counter = 1;

              function processOrderedList(listNode) {
                let child = listNode.firstChild;

                while (child) {
                  if (child.type.name === "ListItem") {
                    const listMark = child.getChild("ListMark");
                    if (listMark) {
                      const markText = view.state.doc.sliceString(
                        listMark.from,
                        listMark.to
                      );
                      // Only process if it's an ordered list marker
                      if (/^\d+[.)]/.test(markText)) {
                        const num = counter++;
                        decorations.push({
                          from: listMark.from,
                          to: listMark.to,
                          value: Decoration.replace({
                            widget: new (class extends WidgetType {
                              toDOM() {
                                const span = document.createElement("span");
                                span.textContent = num + ".";
                                span.style.marginRight = "4px";
                                return span;
                              }
                            })(),
                          }),
                        });
                      }
                    }
                    // Check for nested ordered lists within this list item
                    let nested = child.firstChild;
                    while (nested) {
                      if (nested.type.name === "OrderedList") {
                        processOrderedList(nested);
                      }
                      nested = nested.nextSibling;
                    }
                  }
                  child = child.nextSibling;
                }
              }

              processOrderedList(node.node);
            } else if (type === "ListItem") {
              // Only handle unordered list items here (ordered handled by OrderedList, tasks handled by Task)
              const parent = node.node.parent;
              if (parent && parent.type.name === "OrderedList") {
                return; // Skip - handled by OrderedList
              }

              // Skip if this is a task list item (handled by Task)
              const task = node.node.getChild("Task");
              const taskMarker = node.node.getChild("TaskMarker");
              if (task || taskMarker) {
                return; // Skip - handled by Task
              }

              const listMark = node.node.getChild("ListMark");
              if (listMark) {
                decorations.push({
                  from: listMark.from,
                  to: listMark.to,
                  value: Decoration.replace({
                    widget: new (class extends WidgetType {
                      toDOM() {
                        const span = document.createElement("span");
                        span.textContent = "•";
                        span.style.marginRight = "4px";
                        return span;
                      }
                    })(),
                  }),
                });
              }
            } else if (type === "Task") {
              // Hide the list marker (- or *) for tasks
              // ListMark is a sibling at the parent (ListItem) level, not a child of Task
              const parent = node.node.parent;
              const listMark = parent
                ? parent.getChild("ListMark")
                : node.node.getChild("ListMark");
              if (listMark) {
                decorations.push({
                  from: listMark.from,
                  to: listMark.to + 1, // +1 to hide the space after the marker
                  value: Decoration.replace({}),
                });
              }

              // Replace task marker with custom tappable checkbox
              const marker = node.node.getChild("TaskMarker");
              if (marker) {
                const markerText = view.state.doc.sliceString(
                  marker.from,
                  marker.to
                );
                const isChecked =
                  markerText.includes("x") || markerText.includes("X");
                const markerFrom = marker.from;
                const markerTo = marker.to;
                decorations.push({
                  from: markerFrom,
                  to: markerTo + 1, // +1 to hide the space after the marker
                  value: Decoration.replace({
                    widget: new (class extends WidgetType {
                      constructor() {
                        super();
                        this.checked = isChecked;
                        this.from = markerFrom;
                        this.to = markerTo;
                      }
                      toDOM() {
                        // Outer tap target - larger than visible checkbox for easier mobile tapping
                        const tapTarget = document.createElement("span");
                        tapTarget.className =
                          "cm-task-checkbox" +
                          (this.checked ? " cm-task-checkbox-checked" : "");
                        tapTarget.style.cssText = `
                      display: inline-flex;
                      align-items: center;
                      justify-content: center;
                      width: 44px;
                      height: 44px;
                      margin: -10px -10px -10px -4px;
                      vertical-align: middle;
                      cursor: pointer;
                      -webkit-tap-highlight-color: transparent;
                    `;
                        // Visible checkbox - Ink & Paper theme
                        const box = document.createElement("span");
                        box.style.cssText = `
                      display: inline-block;
                      width: 20px;
                      height: 20px;
                      border: 2px solid ${this.checked ? "#3D5A80" : "#C4BFB6"};
                      border-radius: 4px;
                      position: relative;
                      background: ${this.checked ? "#3D5A80" : "transparent"};
                      flex-shrink: 0;
                      transition: all 0.15s ease;
                    `;
                        if (this.checked) {
                          // Draw checkmark
                          const check = document.createElement("span");
                          check.style.cssText = `
                        position: absolute;
                        left: 4px;
                        top: 1px;
                        width: 5px;
                        height: 10px;
                        border: solid #FAF9F6;
                        border-width: 0 2px 2px 0;
                        transform: rotate(45deg);
                      `;
                          box.appendChild(check);
                        }
                        tapTarget.appendChild(box);
                        // Store position data for click handler
                        tapTarget.dataset.from = this.from;
                        tapTarget.dataset.to = this.to;
                        tapTarget.dataset.checked = this.checked;
                        return tapTarget;
                      }
                      eq(other) {
                        return (
                          this.checked === other.checked &&
                          this.from === other.from
                        );
                      }
                      ignoreEvent() {
                        return false; // Allow click events through
                      }
                    })(),
                  }),
                });
                if (isChecked) {
                  decorations.push({
                    from: marker.to,
                    to: node.to,
                    value: Decoration.mark({ class: "cm-md-task-checked" }),
                  });
                }
              }
            } else if (type === "FencedCode") {
              const codeInfo = node.node.getChild("CodeInfo");
              const codeMark = node.node.getChild("CodeMark");
              if (codeMark) {
                const hideEnd = codeInfo ? codeInfo.to : codeMark.to;
                decorations.push({
                  from: codeMark.from,
                  to: hideEnd,
                  value: Decoration.replace({}),
                });
              }
              const marks = node.node.getChildren("CodeMark");
              if (marks.length > 1) {
                decorations.push({
                  from: marks[marks.length - 1].from,
                  to: marks[marks.length - 1].to,
                  value: Decoration.replace({}),
                });
              }
              // Apply line decorations for code block styling
              const startLine = view.state.doc.lineAt(from).number;
              const endLine = view.state.doc.lineAt(to).number;
              for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
                const line = view.state.doc.line(lineNum);
                let posClass;
                if (startLine === endLine) {
                  posClass = "cm-md-codeblock-single";
                } else if (lineNum === startLine) {
                  posClass = "cm-md-codeblock-first";
                } else if (lineNum === endLine) {
                  posClass = "cm-md-codeblock-last";
                } else {
                  posClass = "cm-md-codeblock-middle";
                }
                decorations.push({
                  from: line.from,
                  to: line.from,
                  value: Decoration.line({
                    class: `cm-md-codeblock ${posClass}`,
                  }),
                });
              }
            } else if (type === "CodeBlock") {
              // Indented code blocks (4 spaces) - use line decorations
              const startLine = view.state.doc.lineAt(from).number;
              const endLine = view.state.doc.lineAt(to).number;
              for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
                const line = view.state.doc.line(lineNum);
                let posClass;
                if (startLine === endLine) {
                  posClass = "cm-md-codeblock-single";
                } else if (lineNum === startLine) {
                  posClass = "cm-md-codeblock-first";
                } else if (lineNum === endLine) {
                  posClass = "cm-md-codeblock-last";
                } else {
                  posClass = "cm-md-codeblock-middle";
                }
                decorations.push({
                  from: line.from,
                  to: line.from,
                  value: Decoration.line({
                    class: `cm-md-codeblock ${posClass}`,
                  }),
                });
              }
            } else if (type === "Table") {
              // Check if cursor is on ANY line of the table
              const tableStartLine = view.state.doc.lineAt(from).number;
              const tableEndLine = view.state.doc.lineAt(to).number;
              let cursorOnTable = false;
              for (const cursorLine of cursorLines) {
                if (
                  cursorLine >= tableStartLine &&
                  cursorLine <= tableEndLine
                ) {
                  cursorOnTable = true;
                  break;
                }
              }

              if (!cursorOnTable) {
                // Parse table and render as HTML widget
                const tableText = view.state.doc.sliceString(from, to);
                const lines = tableText.split("\n");

                // Helper to parse inline markdown
                const parseInlineMarkdown = (text) => {
                  return (
                    text
                      // Code (must be first to prevent other parsing inside)
                      .replace(/`([^`]+)`/g, "<code>$1</code>")
                      // Bold
                      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
                      .replace(/__([^_]+)__/g, "<strong>$1</strong>")
                      // Italic
                      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
                      .replace(/_([^_]+)_/g, "<em>$1</em>")
                      // Strikethrough
                      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
                      // Links
                      .replace(
                        /\[([^\]]+)\]\(([^)]+)\)/g,
                        '<a href="$2">$1</a>'
                      )
                      // Escaped pipes (convert placeholder back)
                      .replace(/\x00/g, "|")
                  );
                };

                // Helper to split on unescaped pipes
                const splitOnPipes = (line) => {
                  // Replace escaped pipes with placeholder
                  const processed = line.replace(/\\\|/g, "\x00");
                  return processed.split("|").map((c) => c.trim());
                };

                // Parse rows (skip delimiter row)
                const rows = [];
                let isHeader = true;
                for (const line of lines) {
                  if (line.includes("---")) {
                    isHeader = false;
                    continue; // Skip delimiter row
                  }
                  // Parse cells from line (handle escaped pipes)
                  const cells = splitOnPipes(line).filter(
                    (c, i, arr) =>
                      (i > 0 && i < arr.length - 1) ||
                      (i === 0 && c) ||
                      (i === arr.length - 1 && c)
                  );
                  if (cells.length > 0) {
                    rows.push({ cells, isHeader });
                  }
                  if (isHeader) isHeader = false; // Only first row is header
                }

                // Hide all table lines and add widget to first line
                for (
                  let lineNum = tableStartLine;
                  lineNum <= tableEndLine;
                  lineNum++
                ) {
                  const line = view.state.doc.line(lineNum);
                  // Hide line content
                  decorations.push({
                    from: line.from,
                    to: line.to,
                    value: Decoration.replace({}),
                  });
                  // Add widget only on first line
                  if (lineNum === tableStartLine) {
                    decorations.push({
                      from: line.from,
                      to: line.from,
                      value: Decoration.widget({
                        widget: new (class extends WidgetType {
                          toDOM() {
                            const wrapper = document.createElement("div");
                            wrapper.className = "cm-md-table-wrapper";
                            const table = document.createElement("table");
                            table.className = "cm-md-table";
                            for (const row of rows) {
                              const tr = document.createElement("tr");
                              for (const cell of row.cells) {
                                const td = document.createElement(
                                  row.isHeader ? "th" : "td"
                                );
                                td.innerHTML = parseInlineMarkdown(cell);
                                tr.appendChild(td);
                              }
                              table.appendChild(tr);
                            }
                            wrapper.appendChild(table);
                            return wrapper;
                          }
                        })(),
                        side: -1,
                      }),
                    });
                  }
                  // Hide non-first lines completely
                  if (lineNum > tableStartLine) {
                    decorations.push({
                      from: line.from,
                      to: line.from,
                      value: Decoration.line({
                        class: "cm-md-table-hidden-line",
                      }),
                    });
                  }
                }
              }
            } else if (type === "HorizontalRule") {
              decorations.push({
                from: from,
                to: to,
                value: Decoration.replace({
                  widget: new (class extends WidgetType {
                    toDOM() {
                      const hr = document.createElement("div");
                      hr.className = "cm-md-hr";
                      hr.style.height = "2px";
                      hr.style.background = "#ddd";
                      hr.style.margin = "8px 0";
                      return hr;
                    }
                  })(),
                }),
              });
            }
          },
        });

        // Let CodeMirror handle sorting (second arg = true)
        return Decoration.set(
          decorations.map((d) => d.value.range(d.from, d.to)),
          true
        );
      } catch (e) {
        console.error("CodeMirror plugin crashed:", e.message, e.stack);
        return Decoration.none;
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

const cleanTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "16px" },
  ".cm-scroller": {
    padding: "16px",
    fontFamily:
      "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  ".cm-content": { caretColor: "#007AFF" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": { display: "none" },
});

const updateListener = EditorView.updateListener.of((update) => {
  if (update.docChanged && !isUpdatingFromRN) {
    window.ReactNativeWebView.postMessage(
      JSON.stringify({
        type: "change",
        content: update.state.doc.toString(),
      })
    );
  }
});

const clipboardHandler = EditorView.domEventHandlers({
  copy(event, view) {
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to);
    if (text) {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: "copy", text })
      );
    }
    event.preventDefault();
    return true;
  },
  cut(event, view) {
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to);
    if (text) {
      window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: "copy", text })
      );
      view.dispatch({ changes: { from, to, insert: "" } });
    }
    event.preventDefault();
    return true;
  },
  paste(event) {
    event.preventDefault();
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "paste" }));
    return true;
  },
});

const taskCheckboxHandler = EditorView.domEventHandlers({
  mousedown(event, view) {
    const target = event.target.closest(".cm-task-checkbox");
    if (!target) return false;

    // Prevent focus/selection changes from the click
    event.preventDefault();
    event.stopPropagation();

    const from = parseInt(target.dataset.from, 10);
    const to = parseInt(target.dataset.to, 10);
    const isChecked = target.dataset.checked === "true";

    // Save scroll position
    const scroller = view.scrollDOM;
    const scrollTop = scroller.scrollTop;

    // Toggle the task marker: [ ] <-> [x]
    const newMarker = isChecked ? "[ ]" : "[x]";
    view.dispatch({
      changes: { from, to, insert: newMarker },
      scrollIntoView: false,
    });

    // Restore scroll position
    requestAnimationFrame(() => {
      scroller.scrollTop = scrollTop;
    });

    return true;
  },
});

function initEditor() {
  document.getElementById("editor").innerHTML = "";
  // Use embedded initial content if available (avoids two-phase init)
  const initialContent = window.INITIAL_CONTENT || "";
  view = new EditorView({
    doc: initialContent,
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown({ extensions: GFM }),
      hideMarkdownPlugin,
      cleanTheme,
      updateListener,
      clipboardHandler,
      taskCheckboxHandler,
      EditorView.lineWrapping,
    ],
    parent: document.getElementById("editor"),
  });
  // Enable mobile keyboard features
  view.contentDOM.setAttribute("autocorrect", "on");
  view.contentDOM.setAttribute("autocomplete", "on");
  view.contentDOM.setAttribute("autocapitalize", "sentences");
  view.contentDOM.setAttribute("spellcheck", "true");
}

function setContent(content) {
  if (!view || view.hasFocus) return;
  isUpdatingFromRN = true;
  const current = view.state.doc.toString();
  if (current !== content) {
    view.dispatch({
      changes: { from: 0, to: current.length, insert: content },
    });
  }
  isUpdatingFromRN = false;
}

function insertAtCursor(text) {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
  });
}

window.handleRNMessage = function (message) {
  const data = JSON.parse(message);
  if (data.type === "init" || data.type === "update" || data.type === "setContent") {
    // For pooled editors, setContent replaces entire document
    if (view) {
      isUpdatingFromRN = true;
      const current = view.state.doc.toString();
      const newContent = data.content || "";
      if (current !== newContent) {
        view.dispatch({
          changes: { from: 0, to: current.length, insert: newContent },
          // Reset selection to start
          selection: { anchor: 0 },
        });
      }
      isUpdatingFromRN = false;
    }
  } else if (data.type === "clear") {
    // Clear editor for pool release
    if (view) {
      isUpdatingFromRN = true;
      const current = view.state.doc.toString();
      if (current.length > 0) {
        view.dispatch({
          changes: { from: 0, to: current.length, insert: "" },
          selection: { anchor: 0 },
        });
      }
      isUpdatingFromRN = false;
    }
  } else if (data.type === "focus" && view) {
    view.focus();
  } else if (data.type === "pasteContent") {
    insertAtCursor(data.text || "");
  }
};

try {
  initEditor();
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: "ready" }));
} catch (e) {
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: "error", message: e.message, stack: e.stack }));
}
