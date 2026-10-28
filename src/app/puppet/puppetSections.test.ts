// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { aimPoint, scrollEntries, sectionOf } from './puppetSections';

function mount(html: string): void {
  document.body.innerHTML = html;
}

function byId(id: string): Element {
  const element = document.getElementById(id);
  if (!element) throw new Error(`no #${id}`);
  return element;
}

afterEach(() => {
  document.body.innerHTML = '';
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

describe('sectionOf', () => {
  it('names nested regions outermost first and prefixes the surface they sit on', () => {
    mount(`
      <div data-puppet-section="top bar"><button id="tab">Home</button></div>
      <aside><button id="search">Search</button>
        <div data-puppet-section="list"><button id="row">ideas</button></div></aside>
      <main><div class="cm-editor" id="editor"></div></main>
      <div role="dialog"><button id="save">Save</button>
        <div data-puppet-section="list"><button id="language">English</button></div></div>
      <div role="menu"><button id="rename">Rename</button></div>
      <div role="menu" data-puppet-section='note "work/retro"'><button id="delete">Delete</button></div>
      <button id="loose">?</button>`);
    expect(sectionOf(byId('tab'))).toBe('top bar');
    expect(sectionOf(byId('search'))).toBe('sidebar');
    expect(sectionOf(byId('row'))).toBe('sidebar · list');
    expect(sectionOf(byId('editor'))).toBe('main');
    expect(sectionOf(byId('save'))).toBe('dialog');
    expect(sectionOf(byId('language'))).toBe('dialog · list');
    expect(sectionOf(byId('rename'))).toBe('menu');
    expect(sectionOf(byId('delete'))).toBe('menu · note "work/retro"');
    expect(sectionOf(byId('loose'))).toBe('content');
  });
});

describe('aimPoint', () => {
  it('aims where the hit test reaches the element: its centre, else a free part of it', () => {
    mount(`<div id="cell"><button id="row"><span id="label">ideas</span></button></div>
      <div id="dialog"></div>`);
    const row = byId('row');
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => ({ left: 100, top: 0, width: 100, height: 40 }),
    });
    const hits = (hit: (x: number) => Element | null) =>
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: (x: number) => hit(x),
      });
    hits(() => byId('label'));
    expect(aimPoint(row)).toEqual({ x: 150, y: 20 });
    hits(() => byId('cell'));
    expect(aimPoint(row), 'a cell that takes the pointer for its row').toEqual({ x: 150, y: 20 });
    hits((x) => (x < 140 ? byId('label') : byId('dialog')));
    expect(aimPoint(row), 'another button over its right half').toEqual({ x: 120, y: 20 });
    hits(() => byId('dialog'));
    expect(aimPoint(row), 'a dialog over all of it').toBeNull();
  });

  it('does not count a backdrop under a row its list has scrolled out of view', () => {
    mount(`<div id="backdrop"><div id="list" style="overflow-y: auto">
      <button id="row">tax 2025</button></div></div>`);
    Object.defineProperty(byId('list'), 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 0, width: 300, height: 100 }),
    });
    Object.defineProperty(byId('row'), 'getBoundingClientRect', {
      value: () => ({ left: 0, top: 200, width: 300, height: 40 }),
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => byId('backdrop'),
    });
    expect(aimPoint(byId('row'))).toBeNull();
  });
});

describe('scrollEntries', () => {
  it('says where a list can still scroll and which of its rows are shown', () => {
    mount(`<div id="list" data-puppet-section="list" data-puppet-rows="52" data-puppet-first-row="10"
        style="overflow-y: auto">
        <div aria-hidden="true"></div>
        <button id="a">a</button><button id="b">b</button><button id="c">c</button>
      </div>`);
    const list = byId('list');
    for (const [key, value] of Object.entries({
      scrollHeight: 2500,
      clientHeight: 500,
      scrollTop: 480,
      scrollWidth: 300,
      clientWidth: 300,
    })) {
      Object.defineProperty(list, key, { configurable: true, value });
    }
    expect(scrollEntries([byId('b'), byId('c')])).toEqual([
      {
        section: 'list',
        up: true,
        down: true,
        left: false,
        right: false,
        first: 12,
        last: 13,
        total: 52,
      },
    ]);
  });
});
