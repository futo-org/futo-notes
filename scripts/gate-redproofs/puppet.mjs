// Gate red-proofs for the puppet gates (check-puppet-first, check-puppet-verbs); listed by ./proofs.mjs.

import { seed, SENTINEL_HEADER } from './seed.mjs';

export const PUPPET_PROOFS = [
  {
    gate: 'puppet-first',
    id: 'instruction-surface-teaches-a-retired-driver',
    seeded: 'created docs/redproof-sentinel.md teaching a raw simulator tap',
    claim: 'an instruction surface that teaches a retired UI driver must fail',
    inject: (wt) =>
      seed.write(
        wt,
        'docs/redproof-sentinel.md',
        `<!-- ${SENTINEL_HEADER.trim()} -->\n# Sentinel\n\n\`\`\`bash\naxe tap --udid $SIM --id bold\n\`\`\`\n`,
      ),
    expect: ['docs/redproof-sentinel.md', 'axe-input'],
    fix: 'check RULES in scripts/check-puppet-first.mjs — the axe-input shape stopped matching, or docs/ left collectInstructionFiles().',
  },
  {
    gate: 'puppet-first',
    id: 'section-marker-does-not-leak-past-its-section',
    seeded:
      'created docs/redproof-marker-leak.md where a marked section ENDS before a second, unmarked violation',
    claim:
      'a section marker must stop allowing at the next heading, or every file could be exempted by one marker at the top',
    inject: (wt) =>
      seed.write(
        wt,
        'docs/redproof-marker-leak.md',
        `<!-- ${SENTINEL_HEADER.trim()} -->\n` +
          '## Allowed\n<!-- check-puppet-first: sentinel -->\n\n`axe tap --udid $SIM --id bold`\n\n' +
          '## Not allowed\n\n`axe tap --udid $SIM --id italic`\n',
      ),
    expect: ['docs/redproof-marker-leak.md', 'axe-input'],
    fix: 'check the `^## ` reset in scanText() of scripts/check-puppet-first.mjs — an open allowance is leaking past its section.',
  },
  {
    gate: 'puppet-verbs',
    id: 'handler-without-verb',
    seeded: 'created src/RedproofSentinel.svelte with an unlabelled onmousedown button and no verb',
    claim: 'a component with a DOM event handler that no verb can be held to must fail',
    inject: (wt) =>
      seed.write(
        wt,
        'src/RedproofSentinel.svelte',
        `<!-- ${SENTINEL_HEADER.trim()} -->\n<button onmousedown={() => {}}>x</button>\n`,
      ),
    expect: ['src/RedproofSentinel.svelte', 'computed label that no check can hold to a verb'],
    fix: 'check DOM_EVENTS and isControl() in scripts/lib/puppet-controls.mjs and walk() in scripts/check-puppet-verbs.mjs — a handler in a scanned src/ component stopped being seen.',
  },
  {
    gate: 'puppet-verbs',
    id: 'wired-listener-without-verb',
    seeded: 'created src/redproof-sentinel-widget.ts wiring its own click listener',
    claim: 'a control that calls addEventListener itself, with no verb, must fail',
    inject: (wt) =>
      seed.write(
        wt,
        'src/redproof-sentinel-widget.ts',
        `${SENTINEL_HEADER}export const probe = (el: HTMLElement) => el.addEventListener('click', () => {});\n`,
      ),
    expect: ['src/redproof-sentinel-widget.ts', 'no registerPuppetVerbs('],
    fix: 'check WIRED_LISTENER in scripts/check-puppet-verbs.mjs — a hand-wired UI listener stopped being seen. That is how the task checkbox went months without a verb.',
  },
  {
    gate: 'puppet-verbs',
    id: 'swiftui-control-without-verb',
    seeded:
      'created apps/ios/Sources/Notes/RedproofSentinelView.swift with a Button and no .puppetVerbs',
    claim: 'a SwiftUI screen with a control and no registered verb must fail',
    inject: (wt) =>
      seed.write(
        wt,
        'apps/ios/Sources/Notes/RedproofSentinelView.swift',
        `// ${SENTINEL_HEADER.trim()}\nimport SwiftUI\n\nstruct RedproofSentinelView: View {\n    var body: some View { Button("x") {} }\n}\n`,
      ),
    expect: ['apps/ios/Sources/Notes/RedproofSentinelView.swift', 'no .puppetVerbs {'],
    fix: 'check SWIFT_HANDLER and the apps/ios/Sources walk in scripts/check-puppet-verbs.mjs — a control in a scanned SwiftUI view stopped being seen.',
  },
  {
    gate: 'puppet-verbs',
    id: 'compose-control-without-verb',
    seeded:
      'created apps/android/app/src/main/java/com/futo/notes/ui/RedproofSentinel.kt with an onClick and no PuppetVerbScope',
    claim: 'a Compose screen with a control and no registered verb must fail',
    inject: (wt) =>
      seed.write(
        wt,
        'apps/android/app/src/main/java/com/futo/notes/ui/RedproofSentinel.kt',
        `// ${SENTINEL_HEADER.trim()}\npackage com.futo.notes.ui\n\nimport androidx.compose.material3.TextButton\nimport androidx.compose.runtime.Composable\n\n@Composable\nfun RedproofSentinel() = TextButton(onClick = {}) {}\n`,
      ),
    expect: [
      'apps/android/app/src/main/java/com/futo/notes/ui/RedproofSentinel.kt',
      'no PuppetVerbScope {',
    ],
    fix: 'check KOTLIN_HANDLER and the apps/android walk in scripts/check-puppet-verbs.mjs — a control in a scanned Compose file stopped being seen.',
  },
  {
    gate: 'puppet-verbs',
    id: 'listener-table-moved',
    seeded:
      'pointed the iOS tables entry in scripts/check-puppet-verbs.mjs at a file that does not exist',
    claim: 'a listener table the gate cannot find must fail, not drop every native verb',
    inject: (wt) =>
      seed.replace(
        wt,
        'scripts/check-puppet-verbs.mjs',
        "tables: ['apps/ios/Sources/App/PuppetServerContract+NativeVerbs.swift']",
        "tables: ['apps/ios/Sources/App/RedproofSentinelMovedTable.swift']",
      ),
    expect: [
      'apps/ios/Sources/App/RedproofSentinelMovedTable.swift',
      'the listener table of native verbs is missing',
    ],
    fix: 'check the tables loop in checkPuppetControls (scripts/check-puppet-verbs.mjs) — a missing listener table is skipped again.',
  },
  {
    gate: 'puppet-verbs',
    id: 'stale-allowlist-entry',
    seeded: "added 'src/redproof-sentinel-gone.svelte' to scripts/puppet-verbs-allowlist.json",
    claim: 'an allowlist entry for a file that does not exist must fail',
    inject: (wt) =>
      seed.json(wt, 'scripts/puppet-verbs-allowlist.json', (data) => {
        data['src/redproof-sentinel-gone.svelte'] = 'seeded by the gate red-proof harness';
      }),
    expect: ['src/redproof-sentinel-gone.svelte', 'allowlisted but the file is gone'],
    fix: 'check the allowlist sweep at the end of checkPuppetVerbs() in scripts/check-puppet-verbs.mjs.',
  },
  {
    gate: 'puppet-verbs',
    id: 'labelled-control-without-verb',
    seeded:
      'created src/RedproofSentinelControl.svelte: a button labelled crashReporting.details.type, which no verb claims, beside an unrelated verb',
    claim: 'a control labelled with a catalog key that no verb claims must fail, per control',
    inject: (wt) =>
      seed.write(
        wt,
        'src/RedproofSentinelControl.svelte',
        `<!-- ${SENTINEL_HEADER.trim()} -->\n<script>registerPuppetVerbs(() => [puppetVerb('RedproofSentinel', {}, () => {}, { controls: ['search.heading'] })]);</script>\n<button onclick={() => {}}>{localizedText('crashReporting.details.type')}</button>\n`,
      ),
    expect: [
      'src/RedproofSentinelControl.svelte',
      '"crashReporting.details.type" that no verb claims',
    ],
    fix: 'check svelteControls() in scripts/lib/puppet-controls.mjs and the claim sweep in checkPuppetControls() — a labelled control stopped being held to a verb.',
  },
  {
    gate: 'puppet-verbs',
    id: 'verb-claiming-no-control',
    seeded:
      "created src/redproof-sentinel-verb.ts: a verb claiming 'crashReporting.details.stack', the text of a heading and of no control",
    claim: 'a verb whose claimed label is on no control must fail',
    inject: (wt) =>
      seed.write(
        wt,
        'src/redproof-sentinel-verb.ts',
        `${SENTINEL_HEADER}export const probe = () => puppetVerb('RedproofSentinel', {}, () => {}, { controls: ['crashReporting.details.stack'] });\n`,
      ),
    expect: ['RedproofSentinel claims "crashReporting.details.stack"', 'no control on desktop'],
    fix: 'check verbDeclarations() in scripts/lib/puppet-controls.mjs and the label sweep in checkPuppetControls() — a verb claiming a missing control stopped failing.',
  },
];
