import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkPuppetControls, checkPuppetVerbs } from './check-puppet-verbs.mjs';
import {
  nativeControlTable,
  nativeControls,
  svelteControls,
  verbDeclarations,
} from './lib/puppet-controls.mjs';

describe('reading controls from source', () => {
  it('a Svelte control is labelled by its label attribute, its own text, or its <label>', () => {
    const source = `
<button aria-label={localizedText('find.close')} onclick={close}>×</button>
<button onclick={send}>{localizedText(sending ? 'feedback.sending' : 'common.send')}</button>
<label>{localizedText('sync.url')}<input bind:value={url} /></label>
<label for="password">{localizedText('sync.password')}</label><input id="password" bind:value={password} />
<div class="backdrop" onclick={close}><h2>{localizedText('settings.heading')}</h2></div>
<div onclick={(event) => event.stopPropagation()}>inert</div>
<Row onclick={open} />
<script>const entries = [{ label: { path: 'notes.copyPath' }, onclick: copy }, { heading: { path: 'notes.sort' } }];</script>`;
    expect(svelteControls(source).map((control) => control.keys)).toEqual([
      ['find.close'],
      ['feedback.sending', 'common.send'],
      ['sync.url'],
      ['sync.password'],
      // A container is labelled only by an attribute: its content is not its name.
      [],
      // A menu entry handed to a shared menu as data; a heading is not a control.
      ['notes.copyPath'],
    ]);
  });

  it('a Compose control is its call with its trailing content, skipping forwards and no-ops', () => {
    const source = `
IconButton(onClick = { menu = true }) {
    Icon(Icons.More, contentDescription = localization.localizedText("notes.more"))
}
Button(onClick = ::send) { Text(localization.localizedText(if (sending) "feedback.sending" else "common.send")) }
Box(Modifier.clickable(onClick = onClick)) { Text(title) }
Box(Modifier.clickable {}) { Text(localization.localizedText("settings.deleting")) }
Switch(checked = on, onCheckedChange = null)
Row(Modifier.toggleable(on, onValueChange = onChange)) { Text(localization.localizedText("sync.live")) }`;
    expect(nativeControls(source, 'kotlin').map((control) => control.keys)).toEqual([
      ['notes.more'],
      ['feedback.sending', 'common.send'],
      ['sync.live'],
    ]);
  });

  it('a SwiftUI control is labelled by its accessibility label over the text inside it', () => {
    const source = `
Button { open() } label: { Image(systemName: "gear") }
    .accessibilityLabel(localization.localizedText("settings.heading"))
Button(localization.localizedText("common.cancel"), role: .cancel) {}
Toggle(isOn: $on) { Text(localization.localizedText("sync.live")) }
ShareLink(item: content) { Label(localization.localizedText("notes.share"), systemImage: "square.and.arrow.up") }`;
    expect(nativeControls(source, 'swift').map((control) => control.keys)).toEqual([
      ['settings.heading'],
      ['common.cancel'],
      ['sync.live'],
      ['notes.share'],
    ]);
  });

  it('a verb declares its controls; a convenience verb and a listener table are read too', () => {
    const ts = `puppetVerb('CloseFind', {}, close, { controls: ['find.close'] }),
      puppetVerb('ScrollBy', {}, scroll, { convenience: true })`;
    expect(verbDeclarations(ts, 'ts')).toMatchObject([
      { name: 'CloseFind', controls: ['find.close'], convenience: false },
      { name: 'ScrollBy', controls: [], convenience: true },
    ]);
    const kotlin = `PuppetVerb("StepFind", required = listOf("direction"), controls = listOf("find.next", "find.previous")) { }`;
    expect(verbDeclarations(kotlin, 'kotlin')[0].controls).toEqual(['find.next', 'find.previous']);
    const swift = `PuppetVerbs.Verb("OpenFind", controls: ["find.open"]) { _ in [:] }`;
    expect(verbDeclarations(swift, 'swift')[0].controls).toEqual(['find.open']);
    const table = `val nativeControls: Map<String, List<String>> = linkedMapOf(
        "OpenNote" to emptyList(),
        "GoBack" to listOf("common.back"),
    )`;
    expect(nativeControlTable(table).map(({ name, controls }) => [name, controls])).toEqual([
      ['OpenNote', []],
      ['GoBack', ['common.back']],
    ]);
  });
});

describe('the per-control gate', () => {
  let root;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const write = (files) => {
    root = mkdtempSync(join(tmpdir(), 'puppet-controls-'));
    const catalog = {
      messages: {
        find: { close: 'Close find', open: 'Find' },
        tags: { remove: 'Remove tag {tagName}' },
      },
    };
    files['languages/en.json'] = JSON.stringify(catalog);
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), text);
    }
  };
  const empty = { computed: {}, noControl: {}, unclaimed: {} };
  const button = (key) => `<button aria-label={localizedText('${key}')} onclick={go}>x</button>\n`;

  it('passes a control whose verb claims its label', () => {
    write({
      'src/Find.svelte': `<script>puppetVerb('CloseFind', {}, go, { controls: ['find.close'] })</script>\n${button('find.close')}`,
    });
    expect(checkPuppetControls({ root, allowlist: empty })).toEqual([]);
  });

  it('fails, with no allowlist file to read, when a platform it scans has lost its listener table', () => {
    write({ 'apps/ios/Sources/Find.swift': 'struct Find {}\n' });
    expect(checkPuppetControls({ root })).toEqual([
      'apps/ios/Sources/App/PuppetServerContract+NativeVerbs.swift: the listener table of native verbs is missing — point tables at the file that holds nativeControls',
    ]);
  });

  it('fails a labelled control no verb claims, and a verb whose label labels nothing', () => {
    write({
      'src/Find.svelte': `<script>puppetVerb('OpenFind', {}, go, { controls: ['find.open'] })</script>\n${button('find.close')}`,
    });
    const failures = checkPuppetControls({ root, allowlist: empty });
    expect(failures.some((f) => f.includes('"find.close" that no verb claims'))).toBe(true);
    expect(failures.some((f) => f.includes('claims "find.open", but no control on desktop'))).toBe(
      true,
    );
  });

  it('sees a control wired only on mousedown, auxclick or dragover', () => {
    write({
      'src/Tags.svelte': `<button onmousedown={go}>{localizedText('find.close')}</button>
<div onauxclick={go}>x</div>
<div ondragover={go}>x</div>\n`,
    });
    const failures = checkPuppetControls({ root, allowlist: empty });
    expect(failures).toContain(
      'src/Tags.svelte:1: a control labelled "find.close" that no verb claims — add the key to the controls of the verb that does what it does, or an unclaimed entry with the reason',
    );
    expect(failures).toContain(
      'src/Tags.svelte: 2 control(s) with a computed label that no check can hold to a verb — label it with a catalog key, or add a computed entry with the reason',
    );
  });

  it('fails a claim of a label with arguments, of a key not in the catalog, and a verb with no control', () => {
    write({
      'src/Tags.svelte': `<script>
        puppetVerb('RemoveTag', {}, go, { controls: ['tags.remove'] });
        puppetVerb('Typo', {}, go, { controls: ['find.clsoe'] });
        puppetVerb('Bare', {}, go);
      </script>\n`,
    });
    const failures = checkPuppetControls({ root, allowlist: empty });
    expect(failures.some((f) => f.includes('"tags.remove", a label with arguments'))).toBe(true);
    expect(
      failures.some((f) => f.includes('"find.clsoe", which is not in languages/en.json')),
    ).toBe(true);
    expect(failures.some((f) => f.includes('Bare names no control'))).toBe(true);
  });

  it('counts computed labels per file against the allowlist, and fails stale entries', () => {
    write({ 'src/Rows.svelte': `<button onclick={go}>{note.title}</button>\n` });
    expect(checkPuppetControls({ root, allowlist: empty })[0]).toContain(
      '1 control(s) with a computed label',
    );
    const listed = { ...empty, computed: { 'src/Rows.svelte': { count: 1, why: 'a note row' } } };
    expect(checkPuppetControls({ root, allowlist: listed })).toEqual([]);
    const stale = { ...listed, unclaimed: { 'desktop:find.close': 'gone' } };
    expect(checkPuppetControls({ root, allowlist: stale })).toEqual([
      'unclaimed "desktop:find.close": no unclaimed control has that label any more',
    ]);
  });
});

describe('the per-file gate', () => {
  let root;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('fails a module that wires a listener and builds no verb, a comment naming one included', () => {
    root = mkdtempSync(join(tmpdir(), 'puppet-verbs-'));
    mkdirSync(join(root, 'src'));
    const files = {
      'src/menu.ts': `el.addEventListener('mousedown', go);\nregisterPuppetVerbs(() => [puppetVerb('Go', {}, go)]);`,
      'src/widget.ts': `el.onclick = go;`,
      'src/later.ts': `// TODO: registerPuppetVerbs( once it has one\nel.addEventListener('wheel', go);`,
      // A component's handlers are held per control.
      'src/Bare.svelte': `<button onclick={go}>x</button>`,
    };
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
    expect(checkPuppetVerbs({ root, allowlist: {} }).sort()).toEqual([
      expect.stringMatching(/^src\/later\.ts: 1 handler \(addEventListener\('wheel'\) and no/),
      expect.stringMatching(/^src\/widget\.ts: 1 handler \(\.onclick =\) and no/),
    ]);
  });
});
