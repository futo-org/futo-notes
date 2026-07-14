import { EditorView, ViewPlugin } from '@codemirror/view';
import type { PluginValue, ViewUpdate } from '@codemirror/view';
import { EDITOR_COMMANDS, filterCommands, type EditorCommand } from './commands';
import { renderIcon } from './icons';
import { commitSlashCommand, getSlashQuery, slashMenuField } from './slashMenuState';

export function computeMenuPlacement(
  anchor: { top: number; bottom: number; left: number },
  menuSize: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number } {
  const gap = 4;
  const spaceBelow = viewport.height - anchor.bottom;
  const spaceAbove = anchor.top;
  const flipAbove = spaceBelow < menuSize.height + gap && spaceAbove > spaceBelow;
  const top = flipAbove ? Math.max(gap, anchor.top - menuSize.height - gap) : anchor.bottom + gap;
  const margin = 8;
  const maxLeft = viewport.width - menuSize.width - margin;

  return { top, left: Math.max(margin, Math.min(anchor.left, maxLeft)) };
}

class SlashMenuRenderer implements PluginValue {
  private readonly dom: HTMLElement;
  private readonly listElement: HTMLElement;
  private readonly emptyElement: HTMLElement;
  private selectedIndex = 0;
  private filteredCommands: EditorCommand[] = EDITOR_COMMANDS;

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement('div');
    this.dom.className = 'sf-slash-menu';
    this.dom.setAttribute('role', 'listbox');
    this.dom.setAttribute('aria-label', 'Insert block');
    this.dom.style.display = 'none';

    this.listElement = document.createElement('div');
    this.listElement.className = 'sf-slash-menu__list';
    this.dom.appendChild(this.listElement);

    this.emptyElement = document.createElement('div');
    this.emptyElement.className = 'sf-slash-menu__empty';
    this.emptyElement.textContent = 'No matching blocks';
    this.emptyElement.style.display = 'none';
    this.dom.appendChild(this.emptyElement);

    view.dom.appendChild(this.dom);
    this.dom.addEventListener('mousedown', (event) => event.preventDefault());
  }

  update(update: ViewUpdate): void {
    const menu = update.state.field(slashMenuField, false);
    if (!menu?.open) {
      this.hide();
      return;
    }

    const nextCommands = filterCommands(getSlashQuery(update.state));
    const commandsChanged =
      nextCommands.length !== this.filteredCommands.length ||
      nextCommands.some((command, index) => command.id !== this.filteredCommands[index]?.id);
    if (commandsChanged) this.selectedIndex = 0;
    this.filteredCommands = nextCommands;

    this.render();
    this.view.requestMeasure({
      read: () => ({
        coords: this.view.coordsAtPos(menu.from),
        host: this.view.dom.getBoundingClientRect(),
        menuSize: { width: this.dom.offsetWidth, height: this.dom.offsetHeight },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
      write: ({ coords, host, menuSize, viewport }) => {
        if (!coords) return;
        const placement = computeMenuPlacement(coords, menuSize, viewport);
        this.dom.style.top = `${placement.top - host.top}px`;
        this.dom.style.left = `${placement.left - host.left}px`;
      },
    });
  }

  move(delta: number): boolean {
    if (!this.filteredCommands.length) return false;
    this.selectedIndex =
      (this.selectedIndex + delta + this.filteredCommands.length) % this.filteredCommands.length;
    this.render();
    return true;
  }

  getSelected(): EditorCommand | null {
    return this.filteredCommands[this.selectedIndex] ?? null;
  }

  private render(): void {
    this.listElement.replaceChildren();
    if (!this.filteredCommands.length) {
      this.listElement.style.display = 'none';
      this.emptyElement.style.display = '';
      this.dom.style.display = '';
      return;
    }
    this.emptyElement.style.display = 'none';
    this.listElement.style.display = '';

    this.filteredCommands.forEach((command, index) => {
      this.listElement.appendChild(this.createCommandItem(command, index));
    });
    this.dom.style.display = '';
  }

  private createCommandItem(command: EditorCommand, index: number): HTMLElement {
    const item = document.createElement('div');
    item.className = 'sf-slash-menu__item';
    item.setAttribute('role', 'option');
    item.setAttribute('data-command-id', command.id);
    if (index === this.selectedIndex) item.setAttribute('aria-selected', 'true');

    const icon = document.createElement('div');
    icon.className = 'sf-slash-menu__icon';
    icon.innerHTML = renderIcon(command.icon);
    item.appendChild(icon);

    const text = document.createElement('div');
    text.className = 'sf-slash-menu__text';
    const label = document.createElement('div');
    label.className = 'sf-slash-menu__label';
    label.textContent = command.label;
    text.appendChild(label);
    if (command.hint) {
      const hint = document.createElement('div');
      hint.className = 'sf-slash-menu__hint';
      hint.textContent = command.hint;
      text.appendChild(hint);
    }
    item.appendChild(text);

    item.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      commitSlashCommand(this.view, command);
    });
    item.addEventListener('click', (event) => {
      event.preventDefault();
      commitSlashCommand(this.view, command);
    });
    item.addEventListener('mouseenter', () => this.selectItem(item, index));
    return item;
  }

  private selectItem(item: HTMLElement, index: number): void {
    this.selectedIndex = index;
    for (const candidate of this.listElement.querySelectorAll<HTMLElement>(
      '.sf-slash-menu__item',
    )) {
      if (candidate === item) candidate.setAttribute('aria-selected', 'true');
      else candidate.removeAttribute('aria-selected');
    }
  }

  private hide(): void {
    this.dom.style.display = 'none';
    this.filteredCommands = EDITOR_COMMANDS;
    this.selectedIndex = 0;
  }

  destroy(): void {
    this.dom.remove();
  }
}

export const slashMenuPlugin = ViewPlugin.fromClass(SlashMenuRenderer);
