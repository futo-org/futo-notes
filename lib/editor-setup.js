// Editor setup - bundled by esbuild and inlined into the WebView
// This file contains the CodeMirror editor initialization and markdown transformation logic

const {
  EditorView, Decoration, ViewPlugin, WidgetType, keymap,
  history, historyKeymap, defaultKeymap,
  syntaxTree, ensureSyntaxTree, markdown
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

const hideMarkdownPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = this.buildDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.focusChanged) {
      this.decorations = this.buildDecorations(update.view);
    }
  }

  buildDecorations(view) {
    const decorations = [];
    const cursorLines = getCursorLines(view);
    const tree = ensureSyntaxTree(view.state, view.state.doc.length, 100) || syntaxTree(view.state);
    if (tree.length === 0) return Decoration.none;

    tree.iterate({
      enter: (node) => {
        const { from, to } = node;
        const visible = view.visibleRanges.some(r => from < r.to && to > r.from);
        if (!visible) return;

        const type = node.type.name;
        const isBlockElement = type.startsWith('ATXHeading') || type === 'Blockquote' ||
          type === 'ListItem' || type === 'Task' || type === 'FencedCode' || type === 'HorizontalRule';

        if (isBlockElement && isOnCursorLine(from, view, cursorLines)) return;

        if (type.startsWith('ATXHeading')) {
          const level = type.charAt(type.length - 1);
          const headerMark = node.node.getChild('HeaderMark');
          if (headerMark) {
            decorations.push({
              from: headerMark.from,
              to: headerMark.to + 1,
              value: Decoration.replace({})
            });
          }
          const contentFrom = headerMark ? headerMark.to + 1 : from;
          if (contentFrom < to) {
            decorations.push({
              from: contentFrom,
              to: to,
              value: Decoration.mark({ class: 'cm-md-h' + level })
            });
          }
        }

        else if (type === 'Emphasis') {
          const marks = node.node.getChildren('EmphasisMark');
          if (marks.length < 2) return;
          if (isCursorInsideElement(view, from, to)) return;

          const closingMark = marks[marks.length - 1];
          decorations.push({
            from: marks[0].to,
            to: closingMark.from,
            value: Decoration.mark({ class: 'cm-md-emphasis' })
          });
          if (!isCursorAtEnd(view, to)) {
            marks.forEach(mark => {
              decorations.push({
                from: mark.from,
                to: mark.to,
                value: Decoration.replace({})
              });
            });
          }
        }

        else if (type === 'StrongEmphasis') {
          const marks = node.node.getChildren('EmphasisMark');
          if (marks.length < 2) return;
          if (isCursorInsideElement(view, from, to)) return;

          const closingMark = marks[marks.length - 1];
          decorations.push({
            from: marks[0].to,
            to: closingMark.from,
            value: Decoration.mark({ class: 'cm-md-strong' })
          });
          if (!isCursorAtEnd(view, to)) {
            marks.forEach(mark => {
              decorations.push({
                from: mark.from,
                to: mark.to,
                value: Decoration.replace({})
              });
            });
          }
        }

        else if (type === 'Strikethrough') {
          const marks = node.node.getChildren('StrikethroughMark');
          if (marks.length < 2) return;
          if (isCursorInsideElement(view, from, to)) return;

          const closingMark = marks[marks.length - 1];
          decorations.push({
            from: marks[0].to,
            to: closingMark.from,
            value: Decoration.mark({ class: 'cm-md-strikethrough' })
          });
          if (!isCursorAtEnd(view, to)) {
            marks.forEach(mark => {
              decorations.push({
                from: mark.from,
                to: mark.to,
                value: Decoration.replace({})
              });
            });
          }
        }

        else if (type === 'InlineCode') {
          const marks = node.node.getChildren('CodeMark');
          if (marks.length < 2) return;
          if (isCursorInsideElement(view, from, to)) return;

          const closingMark = marks[marks.length - 1];
          decorations.push({
            from: marks[0].to,
            to: closingMark.from,
            value: Decoration.mark({ class: 'cm-md-code' })
          });
          if (!isCursorAtEnd(view, to)) {
            marks.forEach(mark => {
              decorations.push({
                from: mark.from,
                to: mark.to,
                value: Decoration.replace({})
              });
            });
          }
        }

        else if (type === 'Link') {
          if (isCursorInsideElement(view, from, to)) return;

          const linkMarks = node.node.getChildren('LinkMark');
          const url = node.node.getChild('URL');

          // Link text is between first [ and first ]
          // LinkMarks are: [, ], (, )
          if (linkMarks.length >= 2) {
            const textFrom = linkMarks[0].to;  // after [
            const textTo = linkMarks[1].from;  // before ]
            if (textTo > textFrom) {
              decorations.push({
                from: textFrom,
                to: textTo,
                value: Decoration.mark({ class: 'cm-md-link' })
              });
            }
          }
          if (!isCursorAtEnd(view, to)) {
            linkMarks.forEach(mark => {
              decorations.push({
                from: mark.from,
                to: mark.to,
                value: Decoration.replace({})
              });
            });
            if (url) {
              decorations.push({
                from: url.from - 1,
                to: url.to + 1,
                value: Decoration.replace({})
              });
            }
          }
        }

        else if (type === 'Blockquote') {
          const quoteMark = node.node.getChild('QuoteMark');
          if (quoteMark) {
            decorations.push({
              from: quoteMark.from,
              to: quoteMark.to + 1,
              value: Decoration.replace({})
            });
          }
          decorations.push({
            from: from,
            to: to,
            value: Decoration.mark({ class: 'cm-md-blockquote' })
          });
        }

        else if (type === 'ListItem') {
          const listMark = node.node.getChild('ListMark');
          if (listMark) {
            decorations.push({
              from: listMark.from,
              to: listMark.to,
              value: Decoration.replace({
                widget: new class extends WidgetType {
                  toDOM() {
                    const span = document.createElement('span');
                    span.textContent = '•';
                    span.style.marginRight = '4px';
                    return span;
                  }
                }
              })
            });
          }
        }

        else if (type === 'Task') {
          const marker = node.node.getChild('TaskMarker');
          if (marker) {
            const markerText = view.state.doc.sliceString(marker.from, marker.to);
            const isChecked = markerText.includes('x') || markerText.includes('X');
            decorations.push({
              from: marker.from,
              to: marker.to,
              value: Decoration.replace({
                widget: new class extends WidgetType {
                  toDOM() {
                    const span = document.createElement('span');
                    span.textContent = isChecked ? '☑' : '☐';
                    span.style.marginRight = '4px';
                    return span;
                  }
                }
              })
            });
            if (isChecked) {
              decorations.push({
                from: marker.to,
                to: node.to,
                value: Decoration.mark({ class: 'cm-md-task-checked' })
              });
            }
          }
        }

        else if (type === 'FencedCode') {
          const codeInfo = node.node.getChild('CodeInfo');
          const codeMark = node.node.getChild('CodeMark');
          if (codeMark) {
            const hideEnd = codeInfo ? codeInfo.to : codeMark.to;
            decorations.push({
              from: codeMark.from,
              to: hideEnd,
              value: Decoration.replace({})
            });
          }
          const marks = node.node.getChildren('CodeMark');
          if (marks.length > 1) {
            decorations.push({
              from: marks[marks.length - 1].from,
              to: marks[marks.length - 1].to,
              value: Decoration.replace({})
            });
          }
          decorations.push({
            from: from,
            to: to,
            value: Decoration.mark({ class: 'cm-md-codeblock' })
          });
        }

        else if (type === 'HorizontalRule') {
          decorations.push({
            from: from,
            to: to,
            value: Decoration.replace({
              widget: new class extends WidgetType {
                toDOM() {
                  const hr = document.createElement('div');
                  hr.className = 'cm-md-hr';
                  hr.style.height = '2px';
                  hr.style.background = '#ddd';
                  hr.style.margin = '8px 0';
                  return hr;
                }
              }
            })
          });
        }
      }
    });

    decorations.sort((a, b) => a.from - b.from || a.to - b.to);
    return Decoration.set(decorations.map(d => d.value.range(d.from, d.to)));
  }
}, {
  decorations: v => v.decorations
});

const cleanTheme = EditorView.theme({
  "&": { height: "100%", fontSize: "16px" },
  ".cm-scroller": { padding: "16px", fontFamily: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, sans-serif" },
  ".cm-content": { caretColor: "#007AFF" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": { display: "none" }
});

const updateListener = EditorView.updateListener.of((update) => {
  if (update.docChanged && !isUpdatingFromRN) {
    window.ReactNativeWebView.postMessage(JSON.stringify({
      type: 'change',
      content: update.state.doc.toString()
    }));
  }
});

const clipboardHandler = EditorView.domEventHandlers({
  copy(event, view) {
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to);
    if (text) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'copy', text }));
    }
    event.preventDefault();
    return true;
  },
  cut(event, view) {
    const { from, to } = view.state.selection.main;
    const text = view.state.sliceDoc(from, to);
    if (text) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'copy', text }));
      view.dispatch({ changes: { from, to, insert: '' } });
    }
    event.preventDefault();
    return true;
  },
  paste(event) {
    event.preventDefault();
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'paste' }));
    return true;
  }
});

function initEditor() {
  document.getElementById('editor').innerHTML = '';
  view = new EditorView({
    doc: '',
    extensions: [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      hideMarkdownPlugin,
      cleanTheme,
      updateListener,
      clipboardHandler,
      EditorView.lineWrapping
    ],
    parent: document.getElementById('editor')
  });
  // Enable mobile keyboard features
  view.contentDOM.setAttribute('autocorrect', 'on');
  view.contentDOM.setAttribute('autocomplete', 'on');
  view.contentDOM.setAttribute('autocapitalize', 'sentences');
  view.contentDOM.setAttribute('spellcheck', 'true');
}

function setContent(content) {
  if (!view || view.hasFocus) return;
  isUpdatingFromRN = true;
  const current = view.state.doc.toString();
  if (current !== content) {
    view.dispatch({ changes: { from: 0, to: current.length, insert: content } });
  }
  isUpdatingFromRN = false;
}

function insertAtCursor(text) {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
}

window.handleRNMessage = function(message) {
  const data = JSON.parse(message);
  if (data.type === 'init' || data.type === 'update') setContent(data.content || '');
  else if (data.type === 'focus' && view) view.focus();
  else if (data.type === 'pasteContent') insertAtCursor(data.text || '');
};

initEditor();
window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
