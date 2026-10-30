// Public capture/read/close contracts with injected OS executors. Every callback
// here is synthetic wire data; none is a dictation acceptance fixture.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { executePhysicalFixture } from './physical-fixture.mjs';
import { readLease } from './physical-fixture-lease.mjs';
import { recorderPayload, setup } from './physical-fixture-test-data.mjs';

const methods = [
  ['shouldChangeText', { range: [0, 1], textUTF16: [33] }, { returned: true }],
  ['replace', { range: [0, 1], textUTF16: [33] }],
  ['setMarkedText', { textUTF16: [0x65e5], relativeSelection: [0, 1] }],
  ['insertText', { textUTF16: [33] }],
  ['selectedTextRange', { range: [0, 1] }],
  ['insertDictationResult', { phrases: [{ textUTF16: [33], alternativesUTF16: [[34], []] }] }],
  ['frameForDictationResultPlaceholder', { token: 1 }, { returnedRect: [1, 2, 3, 4] }],
  ['removeDictationResultPlaceholder', { token: 1, willInsertResult: false }],
  ['didChange', {}],
  ['didChangeSelection', {}],
  ['unmarkText', {}],
  ['deleteBackward', {}],
  ['insertDictationResultPlaceholder', {}, { returnedToken: 1 }],
  ['dictationRecordingDidEnd', {}],
  ['dictationRecognitionFailed', {}],
];
const callback = ([method, args, returns = {}]) => ({
  ...recorderPayload().events[0],
  method,
  arguments: JSON.parse(JSON.stringify(args)),
  ...JSON.parse(JSON.stringify(returns)),
});

async function roundTrip(change) {
  const t = setup();
  const copy = t.runtime.executor.copyArtifact;
  const artifact = JSON.parse(copy());
  change(artifact);
  const raw = JSON.stringify(artifact);
  t.runtime.executor.copyArtifact = () => raw;
  try {
    expect((await executePhysicalFixture('capture', t.plan, t.runtime)).status).toBe('captured');
    expect((await executePhysicalFixture('read', t.plan, t.runtime)).artifact).toEqual(artifact);
    expect((await executePhysicalFixture('close', t.plan, t.runtime)).status).toBe('closed');
  } finally {
    t.clean();
  }
}

it.each(methods.map((method) => [method[0], method]))(
  'preserves the complete synthetic %s callback through public capture/read/close',
  async (_name, method) =>
    roundTrip((a) => {
      a.events = [callback(method)];
    }),
);

it('preserves native nullable/optional fields and raw observations without imposing state semantics', async () => {
  await roundTrip((a) => {
    const nativeNotFound = JSON.parse('9223372036854775807');
    a.opening.selected = null;
    a.opening.marked = [8, -1];
    a.opening.language = null;
    a.opening.availableLanguages = [];
    a.current.selected = null;
    a.current.textUTF16 = [0xd800, 0x0085, 0x205f, 13, 10, 0xdfff];
    a.events = methods.map(callback);
    a.events[0].returned = false;
    a.events[0].arguments.range = [nativeNotFound, -1];
    a.events[1].before.selected = [-1, nativeNotFound];
    a.events[1].after.marked = [99, 2];
    a.events[2].arguments = { textUTF16: null, relativeSelection: [nativeNotFound, 0] };
    a.events[4].arguments.range = null;
    a.events[5].arguments.phrases.push({ textUTF16: [], alternativesUTF16: null });
    a.events[6].arguments.token = null;
    a.events[6].returnedRect = ['inf', '-inf', 'nan', -0.5];
    a.events[7].arguments.token = null;
    a.events[7].arguments.willInsertResult = true;
    a.events[12].returnedToken = 909;
    // Callback parents/tokens and timing are raw observations, not a graph or
    // clock policy inferred by this transport validator.
    a.events[1].parent = 987;
    a.events.reverse();
    a.lifecycle.reverse();
    a.lifecycle.push({ event: 'UIApplicationDidBecomeActiveNotification', uptime: 0.25, time: '' });
    a.traits.keyboard = 999;
  });
});

it('preserves empty native dictation phrases and alternatives', async () => {
  await roundTrip((a) => {
    a.events = [callback(['insertDictationResult', { phrases: [] }])];
  });
});

const malformed = [];
const add = (name, change) => malformed.push([name, change]);
const wrong = [null, true, 7, 'wrong', [], {}, ['value']];
for (const field of [
  'runID',
  'nonce',
  'declaredDestination',
  'destinationBinding',
  'acceptance',
  'status',
  'maximumDurationSeconds',
  'provenance',
]) {
  add(`missing ${field}`, (a) => {
    delete a[field];
  });
  for (const value of wrong) {
    if (field === 'maximumDurationSeconds' && Number.isInteger(value)) continue;
    if (field === 'provenance' && value && typeof value === 'object' && !Array.isArray(value))
      continue;
    if (!['maximumDurationSeconds', 'provenance'].includes(field) && typeof value === 'string')
      continue;
    add(`envelope ${field}=${JSON.stringify(value)}`, (a) => {
      a[field] = value;
    });
  }
}
for (const field of ['opening', 'current']) {
  for (const value of wrong)
    add(`${field}=${JSON.stringify(value)}`, (a) => {
      a[field] = value;
    });
}
for (const field of ['before', 'after']) {
  for (const value of wrong)
    add(`${field}=${JSON.stringify(value)}`, (a) => {
      a.events[0][field] = value;
    });
}
for (const field of ['opening', 'current', 'events', 'lifecycle', 'traits', 'os']) {
  add(`missing ${field}`, (a) => {
    delete a[field];
  });
}
for (const value of [null, true, 7, 'wrong', {}, [null], [7]]) {
  add(`events=${JSON.stringify(value)}`, (a) => {
    a.events = value;
  });
}
for (const field of ['id', 'parent', 'method', 'arguments', 'before', 'after']) {
  add(`callback missing ${field}`, (a) => {
    delete a.events[0][field];
  });
}
for (const value of wrong) {
  if (!Number.isInteger(value))
    add(`id=${JSON.stringify(value)}`, (a) => {
      a.events[0].id = value;
    });
  if (value !== null && !Number.isInteger(value))
    add(`parent=${JSON.stringify(value)}`, (a) => {
      a.events[0].parent = value;
    });
  add(`method=${JSON.stringify(value)}`, (a) => {
    a.events[0].method = value;
  });
  add(`arguments=${JSON.stringify(value)}`, (a) => {
    a.events[0].arguments = value;
  });
}
for (const field of ['id', 'parent']) {
  add(`${field} fractional`, (a) => {
    a.events[0][field] = 1.5;
  });
}
for (const getSnapshot of [
  ['opening', (a) => a.opening],
  ['current', (a) => a.current],
  ['before', (a) => a.events[0].before],
  ['after', (a) => a.events[0].after],
]) {
  const [name, get] = getSnapshot;
  for (const field of ['textUTF16', 'selected', 'marked', 'language', 'availableLanguages']) {
    add(`${name} missing ${field}`, (a) => {
      delete get(a)[field];
    });
  }
  for (const value of [null, true, 7, 'a', {}, [-1], [65536], [1.5], ['1'], [null]]) {
    add(`${name} textUTF16=${JSON.stringify(value)}`, (a) => {
      get(a).textUTF16 = value;
    });
  }
  for (const field of ['selected', 'marked']) {
    for (const value of [true, 7, 'a', {}, [], [1], [0, 1, 2], ['0', 1], [null, 1], [0.5, 1]]) {
      add(`${name} ${field}=${JSON.stringify(value)}`, (a) => {
        get(a)[field] = value;
      });
    }
  }
  for (const value of [true, 7, {}, [], ['en-US']]) {
    add(`${name} language=${JSON.stringify(value)}`, (a) => {
      get(a).language = value;
    });
  }
  for (const value of [null, true, 7, 'en-US', {}, [null], [1], [['en-US']]]) {
    add(`${name} availableLanguages=${JSON.stringify(value)}`, (a) => {
      get(a).availableLanguages = value;
    });
  }
  add(`${name} unknown member`, (a) => {
    get(a).future = true;
  });
}
for (const method of methods) {
  const [name, args, returns = {}] = method;
  for (const field of Object.keys(args)) {
    add(`${name} missing argument ${field}`, (a) => {
      a.events = [callback(method)];
      delete a.events[0].arguments[field];
    });
    for (const value of wrong) {
      // Null/range and nullable text/token are actually emitted by UIKit.
      if (
        value === null &&
        (field === 'token' ||
          (name === 'selectedTextRange' && field === 'range') ||
          (name === 'setMarkedText' && field === 'textUTF16'))
      )
        continue;
      if (field === 'token' && Number.isInteger(value)) continue;
      if (field === 'willInsertResult' && typeof value === 'boolean') continue;
      // UTF16 and phrase arrays can be empty native observations.
      if (Array.isArray(value) && value.length === 0 && ['textUTF16', 'phrases'].includes(field))
        continue;
      add(`${name} ${field}=${JSON.stringify(value)}`, (a) => {
        a.events = [callback(method)];
        a.events[0].arguments = { ...args, [field]: value };
      });
    }
  }
  for (const field of Object.keys(args)) {
    const values = ['range', 'relativeSelection'].includes(field)
      ? [[], [0], [0, 1, 2], [null, 1], ['0', 1], [0.5, 1], [0, []]]
      : field === 'textUTF16'
        ? [[-1], [65536], [null], [true], [[]], [0.5]]
        : field === 'token'
          ? [0.5]
          : [];
    for (const value of values)
      add(`${name} nested ${field}=${JSON.stringify(value)}`, (a) => {
        a.events = [callback(method)];
        a.events[0].arguments[field] = value;
      });
  }
  for (const field of Object.keys(returns)) {
    add(`${name} missing ${field}`, (a) => {
      a.events = [callback(method)];
      delete a.events[0][field];
    });
    for (const value of wrong) {
      if (field === 'returned' && typeof value === 'boolean') continue;
      if (field === 'returnedToken' && Number.isInteger(value)) continue;
      add(`${name} ${field}=${JSON.stringify(value)}`, (a) => {
        a.events = [{ ...callback(method), [field]: value }];
      });
    }
  }
  add(`${name} unknown argument`, (a) => {
    a.events = [callback([name, { ...args, future: true }, returns])];
  });
}
for (const phrase of [
  null,
  true,
  {},
  { textUTF16: [1] },
  { alternativesUTF16: null },
  { textUTF16: [65536], alternativesUTF16: null },
  { textUTF16: [1], alternativesUTF16: [null] },
  { textUTF16: [1], alternativesUTF16: ['text'] },
  { textUTF16: [1], alternativesUTF16: [[65536]] },
  { textUTF16: [1], alternativesUTF16: [], future: true },
]) {
  add(`dictation phrase=${JSON.stringify(phrase)}`, (a) => {
    a.events = [callback(['insertDictationResult', { phrases: [phrase] }])];
  });
}
for (const rect of [
  [1, 2, 3],
  [1, 2, 3, 4, 5],
  [1, 2, 3, null],
  [1, 2, 3, []],
  [1, 2, 3, {}],
  [1, 2, 3, true],
]) {
  add(`returnedRect=${JSON.stringify(rect)}`, (a) => {
    a.events = [
      callback(['frameForDictationResultPlaceholder', { token: null }, { returnedRect: rect }]),
    ];
  });
}
for (const field of [
  'autocorrection',
  'autocapitalization',
  'spellChecking',
  'keyboard',
  'deviceModel',
  'systemName',
  'systemVersion',
]) {
  add(`traits missing ${field}`, (a) => {
    delete a.traits[field];
  });
  const values = ['deviceModel', 'systemName', 'systemVersion'].includes(field)
    ? [null, true, 1, [], {}, ['iOS']]
    : [null, true, '1', [], {}, [1], 1.5];
  for (const value of values)
    add(`traits ${field}=${JSON.stringify(value)}`, (a) => {
      a.traits[field] = value;
    });
}
for (const value of [null, true, 7, 'stamp', {}, [null], [7]]) {
  add(`lifecycle=${JSON.stringify(value)}`, (a) => {
    a.lifecycle = value;
  });
}
for (const field of ['event', 'uptime', 'time']) {
  add(`lifecycle missing ${field}`, (a) => {
    delete a.lifecycle[0][field];
  });
  for (const value of wrong) {
    if (
      (field === 'uptime' && Number.isFinite(value)) ||
      (field !== 'uptime' && typeof value === 'string')
    )
      continue;
    add(`lifecycle ${field}=${JSON.stringify(value)}`, (a) => {
      a.lifecycle[0][field] = value;
    });
  }
}
add('unknown version', (a) => {
  a.formatVersion = 2;
});
add('typed version', (a) => {
  a.formatVersion = [1];
});
add('unknown artifact member', (a) => {
  a.future = true;
});
add('unknown callback member', (a) => {
  a.events[0].future = true;
});
add('typed optional returned', (a) => {
  a.events[0].returned = ['true'];
});
add('unknown traits member', (a) => {
  a.traits.future = true;
});
add('unknown lifecycle member', (a) => {
  a.lifecycle[0].future = true;
});

it.each(malformed)(
  'refuses %s before promoting capture or retained read',
  async (_name, change) => {
    for (const operation of ['capture', 'read']) {
      const t = setup();
      const copy = t.runtime.executor.copyArtifact;
      const artifact = JSON.parse(copy());
      change(artifact);
      const raw = JSON.stringify(artifact);
      const output = join(t.runtime.scratch, t.plan.runID);
      try {
        if (operation === 'capture') {
          t.runtime.executor.copyArtifact = () => raw;
          await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(
            /artifact/,
          );
          const receipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
          expect(receipt.status).toBe('failed');
          expect(receipt.artifactSHA256).toBeUndefined();
          expect((await executePhysicalFixture('close', t.plan, t.runtime)).status).toBe('closed');
          expect(() => readLease(t.plan, t.runtime.leaseRuntime)).toThrow();
        } else {
          await executePhysicalFixture('capture', t.plan, t.runtime);
          writeFileSync(join(output, 'capture.json'), raw);
          const receiptPath = join(output, 'receipt.json');
          const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
          // Matching the hash cannot make malformed raw evidence readable or a
          // recognized captured terminal. Do not rely on hash rejection instead.
          receipt.artifactSHA256 = createHash('sha256').update(raw).digest('hex');
          writeFileSync(receiptPath, JSON.stringify(receipt));
          await expect(executePhysicalFixture('read', t.plan, t.runtime)).rejects.toThrow(
            /artifact/,
          );
          await expect(executePhysicalFixture('close', t.plan, t.runtime)).rejects.toThrow(
            /artifact/,
          );
          expect(readLease(t.plan, t.runtime.leaseRuntime).runID).toBe(t.plan.runID);
        }
        expect(readFileSync(join(output, 'capture.json'), 'utf8')).toBe(raw);
      } finally {
        t.clean();
      }
    }
  },
);

it('retains malformed callback bytes as failed evidence and permits explicit failed close', async () => {
  const t = setup();
  const copy = t.runtime.executor.copyArtifact;
  const raw = JSON.stringify({ ...JSON.parse(copy()), events: [null] });
  t.runtime.executor.copyArtifact = () => raw;
  try {
    await expect(executePhysicalFixture('capture', t.plan, t.runtime)).rejects.toThrow(/artifact/);
    const output = join(t.runtime.scratch, t.plan.runID);
    expect(readFileSync(join(output, 'capture.json'), 'utf8')).toBe(raw);
    const receipt = JSON.parse(readFileSync(join(output, 'receipt.json'), 'utf8'));
    expect(receipt.status).toBe('failed');
    expect(receipt.artifactSHA256).toBeUndefined();
    await expect(executePhysicalFixture('read', t.plan, t.runtime)).rejects.toThrow(
      /remains failed/,
    );
    expect((await executePhysicalFixture('close', t.plan, t.runtime)).status).toBe('closed');
    expect(() => readLease(t.plan, t.runtime.leaseRuntime)).toThrow();
    expect(readFileSync(join(output, 'capture.json'), 'utf8')).toBe(raw);
  } finally {
    t.clean();
  }
});
