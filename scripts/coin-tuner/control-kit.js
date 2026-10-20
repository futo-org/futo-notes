// The widgets the control panels are built from: one control, one collapsible group, one note.

import { applyAll } from './apply-all.js';

const panels = document.getElementById('panels');

export function control(parent, spec) {
  const wrap = document.createElement('div');
  wrap.className = spec.kind === 'range' ? 'control' : 'control inline';

  const label = document.createElement('label');
  label.textContent = spec.label;
  wrap.appendChild(label);

  const readout = document.createElement('span');
  readout.className = 'value';
  wrap.appendChild(readout);

  let input;
  if (spec.kind === 'range') {
    input = document.createElement('input');
    input.type = 'range';
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step;
  } else if (spec.kind === 'colour') {
    input = document.createElement('input');
    input.type = 'color';
  } else if (spec.kind === 'select') {
    input = document.createElement('select');
    for (const [value, text] of spec.options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = text;
      input.appendChild(option);
    }
  } else if (spec.kind === 'toggle') {
    input = document.createElement('input');
    input.type = 'checkbox';
  }

  const push = () => {
    spec.set(spec.kind === 'toggle' ? input.checked : input.value);
    applyAll();
  };
  input.addEventListener(spec.kind === 'range' ? 'input' : 'change', push);
  if (spec.kind === 'range') input.addEventListener('change', push);
  wrap.appendChild(input);
  parent.appendChild(wrap);

  return () => {
    const value = spec.get();
    if (spec.kind === 'toggle') input.checked = value;
    else input.value = value;
    readout.textContent = spec.format === undefined ? '' : spec.format(value);
  };
}

export function group(title, open, build) {
  const details = document.createElement('details');
  details.className = 'group';
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = title;
  details.appendChild(summary);
  const body = document.createElement('div');
  body.className = 'group-body';
  details.appendChild(body);
  panels.appendChild(details);
  return build(body);
}

export function noteInto(parent, text, className = 'note') {
  const paragraph = document.createElement('p');
  paragraph.className = className;
  paragraph.textContent = text;
  parent.appendChild(paragraph);
}
