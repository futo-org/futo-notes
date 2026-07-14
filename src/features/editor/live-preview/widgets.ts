import { EditorView, WidgetType } from '@codemirror/view';

const CODE_LANGUAGE_LABELS: Record<string, string> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  tsx: 'TypeScript JSX',
  jsx: 'JavaScript JSX',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  html: 'HTML',
  css: 'CSS',
  json: 'JSON',
  yaml: 'YAML',
  xml: 'XML',
  sql: 'SQL',
  bash: 'Bash',
  sh: 'Bash',
  zsh: 'Zsh',
  shell: 'Shell',
  md: 'Markdown',
  markdown: 'Markdown',
};

const HORIZONTAL_RULE_HEIGHT = 50;

export class WikilinkDisplayWidget extends WidgetType {
  constructor(
    private readonly display: string,
    private readonly title: string,
    private readonly broken: boolean,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = this.broken
      ? 'cm-md-link cm-md-wikilink cm-md-wikilink-broken'
      : 'cm-md-link cm-md-wikilink';
    element.dataset.wikilink = this.title;
    element.textContent = this.display;
    return element;
  }

  eq(other: WikilinkDisplayWidget): boolean {
    return (
      other.display === this.display && other.title === this.title && other.broken === this.broken
    );
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class ExternalLinkWidget extends WidgetType {
  constructor(private readonly extraClasses = '') {
    super();
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span');
    element.className = `cm-md-external-link cm-url ${this.extraClasses}`.trim();
    element.setAttribute('aria-hidden', 'true');
    return element;
  }

  eq(other: ExternalLinkWidget): boolean {
    return other.extraClasses === this.extraClasses;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export class CodeLanguageLabelWidget extends WidgetType {
  constructor(private readonly label: string) {
    super();
  }

  toDOM(): HTMLElement {
    const element = document.createElement('div');
    element.className = 'cm-md-code-lang-label';
    element.textContent = this.label;
    return element;
  }

  eq(other: CodeLanguageLabelWidget): boolean {
    return other.label === this.label;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class HorizontalRuleWidget extends WidgetType {
  get estimatedHeight(): number {
    return HORIZONTAL_RULE_HEIGHT;
  }

  toDOM(): HTMLElement {
    const rule = document.createElement('div');
    rule.className = 'cm-md-hr-widget';
    rule.appendChild(document.createElement('div'));
    return rule;
  }

  eq(): boolean {
    return true;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

export class TaskCheckboxWidget extends WidgetType {
  constructor(private readonly checked: boolean) {
    super();
  }

  get estimatedHeight(): number {
    return 0;
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.className = 'cm-md-task-checkbox-wrapper';
    wrapper.style.cssText =
      'display:inline-flex;align-items:center;justify-content:center;min-width:28px;min-height:28px;padding-right:4px;cursor:pointer;vertical-align:middle';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = this.checked;
    checkbox.className = 'cm-md-task-checkbox';
    checkbox.style.cssText = 'width:18px;height:18px;cursor:pointer;margin:0';

    wrapper.addEventListener('mousedown', (event) => event.preventDefault());
    wrapper.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleTaskAtElement(wrapper);
    });
    wrapper.appendChild(checkbox);
    return wrapper;
  }

  eq(other: TaskCheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function formatCodeLanguage(slug: string): string {
  return CODE_LANGUAGE_LABELS[slug.toLowerCase()] ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

function toggleTaskAtElement(element: HTMLElement): void {
  const editorElement = element.closest('.cm-editor') as HTMLElement | null;
  if (!editorElement) return;

  const view = EditorView.findFromDOM(editorElement);
  if (!view) return;

  const hadFocus = view.hasFocus;
  const line = view.state.doc.lineAt(view.posAtDOM(element));
  const marker = line.text.match(/\[([ xX])\]/);
  if (!marker || marker.index === undefined) return;

  const from = line.from + marker.index + 1;
  view.dispatch({
    changes: { from, to: from + 1, insert: marker[1] === ' ' ? 'x' : ' ' },
    selection: view.state.selection,
  });
  if (!hadFocus) view.contentDOM.blur();
}
