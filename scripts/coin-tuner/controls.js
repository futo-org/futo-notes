// Every dial on the page, grouped as the panels show them.

import { BACKDROPS, TONE_MAPS } from './constants.js';
import { worstAngle } from './measure.js';
import { applyAll } from './apply-all.js';
import { control, group, noteInto } from './control-kit.js';
import { number } from './format-number.js';
import { state, resetState } from './state.js';
import { syncers } from './sync-controls.js';

export function buildControls() {
  syncers.push(
    ...group('Looking at it', true, (body) => {
      noteInto(
        body,
        'The coin is 160px on a 184px well in the licensed plate, on --color-surface. ' +
          'Brightness is judged against that card, not against a void. "Gold left" is ' +
          'the reading to watch: as shipped the coin sits near 54%, and the same coin ' +
          'with its five lamps off measures 98%. That gap is what "too bright" is.',
      );
      const made = [];
      made.push(
        control(body, {
          kind: 'select',
          label: 'Backdrop',
          options: BACKDROPS.map(([hex, name]) => [hex, `${name}  ${hex}`]),
          get: () => state.backdrop,
          set: (value) => (state.backdrop = value),
        }),
      );
      made.push(
        control(body, {
          kind: 'range',
          label: 'Coin size',
          min: 96,
          max: 400,
          step: 8,
          get: () => state.sizePx,
          set: (value) => (state.sizePx = Number(value)),
          format: (value) => `${value}px`,
        }),
      );
      made.push(
        control(body, {
          kind: 'toggle',
          label: 'Spin',
          get: () => state.spinning,
          set: (value) => (state.spinning = value),
        }),
      );
      made.push(
        control(body, {
          kind: 'range',
          label: 'Tilt',
          min: 0,
          max: 0.8,
          step: 0.01,
          get: () => state.tilt,
          set: (value) => (state.tilt = Number(value)),
          format: (value) => `${number(value, 2)} rad`,
        }),
      );
      made.push(
        control(body, {
          kind: 'toggle',
          label: 'Compare: show shipped values',
          get: () => state.showShipped,
          set: (value) => (state.showShipped = value),
        }),
      );

      const row = document.createElement('div');
      row.className = 'row';
      const sweep = document.createElement('button');
      sweep.textContent = 'Find the palest angle';
      sweep.addEventListener('click', worstAngle);
      row.appendChild(sweep);
      const reset = document.createElement('button');
      reset.textContent = 'Reset to shipped';
      reset.addEventListener('click', () => {
        resetState();
        applyAll();
      });
      row.appendChild(reset);
      body.appendChild(row);
      return made;
    }),
  );

  syncers.push(
    ...group('Per-shell exposure — no regeneration', true, (body) => {
      noteInto(
        body,
        'One number per shell, and they are a matched triple: turning one without the ' +
          'other two makes the same coin a different object on each platform. This dims ' +
          'everything at once, highlight and gold body together.',
      );
      const made = [
        control(body, {
          kind: 'range',
          label: 'Desktop exposure',
          min: 0.2,
          // Up to 6 because this slider is also how the OTHER shells get
          // calibrated: Android's Filament intensity and iOS's RealityKit
          // exponent are converted by finding the desktop exposure that renders
          // the same coin, and Android's shipped 4.5 lands well above 2.
          max: 6,
          step: 0.01,
          get: () => state.exposure,
          set: (value) => (state.exposure = Number(value)),
          format: (value) => number(value, 2),
        }),
        control(body, {
          kind: 'select',
          label: 'Tone map',
          options: TONE_MAPS.map(([key, name]) => [key, name]),
          get: () => state.toneMap,
          set: (value) => (state.toneMap = value),
        }),
      ];
      return made;
    }),
  );

  syncers.push(
    ...group('Material — needs `just coin`', true, (body) => {
      noteInto(
        body,
        'Roughness is the dial for a highlight that is too hot without making the coin ' +
          'darker: a rougher metal spreads the same light over more of the face, so the ' +
          'peak drops while the body does not. Base color multiplies the reflection ' +
          'itself, because gold is a metal — it dims the highlight too.',
      );
      return [
        control(body, {
          kind: 'range',
          label: 'Face roughness',
          min: 0.02,
          max: 0.8,
          step: 0.01,
          get: () => state.material.faceRoughness,
          set: (value) => (state.material.faceRoughness = Number(value)),
          format: (value) => number(value, 2),
        }),
        control(body, {
          kind: 'range',
          label: 'Rim roughness',
          min: 0.02,
          max: 0.8,
          step: 0.01,
          get: () => state.material.rimRoughness,
          set: (value) => (state.material.rimRoughness = Number(value)),
          format: (value) => number(value, 2),
        }),
        control(body, {
          kind: 'colour',
          label: 'Face color',
          get: () => `#${state.material.faceHex.toString(16).padStart(6, '0')}`,
          set: (value) => (state.material.faceHex = Number.parseInt(value.slice(1), 16)),
        }),
        control(body, {
          kind: 'colour',
          label: 'Rim color',
          get: () => `#${state.material.rimHex.toString(16).padStart(6, '0')}`,
          set: (value) => (state.material.rimHex = Number.parseInt(value.slice(1), 16)),
        }),
      ];
    }),
  );

  syncers.push(
    ...group('The room — needs `just coin`', false, (body) => {
      noteInto(
        body,
        'The coin against everything that is not a lamp. Lowering the ceiling darkens ' +
          'the coin at every angle while the highlights keep their punch — the opposite ' +
          'trade from the exposure slider.',
      );
      return [
        control(body, {
          kind: 'range',
          label: 'Ceiling (sky)',
          min: 0,
          max: 3,
          step: 0.01,
          get: () => state.room.skyScale,
          set: (value) => (state.room.skyScale = Number(value)),
          format: (value) => `x${number(value, 2)}`,
        }),
        control(body, {
          kind: 'range',
          label: 'Ambient floor',
          min: 0,
          max: 4,
          step: 0.01,
          get: () => state.room.ambientScale,
          set: (value) => (state.room.ambientScale = Number(value)),
          format: (value) => `x${number(value, 2)}`,
        }),
        control(body, {
          kind: 'range',
          label: 'Floor take-out',
          min: 0,
          max: 4,
          step: 0.01,
          get: () => state.room.floorScale,
          set: (value) => (state.room.floorScale = Number(value)),
          format: (value) => `x${number(value, 2)}`,
        }),
        control(body, {
          kind: 'range',
          label: 'Sky exponent',
          min: 0.4,
          max: 4,
          step: 0.05,
          get: () => state.room.skyExponent,
          set: (value) => (state.room.skyExponent = Number(value)),
          format: (value) => number(value, 2),
        }),
        control(body, {
          kind: 'range',
          label: 'Floor exponent',
          min: 0.4,
          max: 4,
          step: 0.05,
          get: () => state.room.floorExponent,
          set: (value) => (state.room.floorExponent = Number(value)),
          format: (value) => number(value, 2),
        }),
      ];
    }),
  );

  state.lobes.forEach((lobe, index) => {
    syncers.push(
      ...group(`Lamp ${index + 1}: ${lobe.name} — needs \`just coin\``, false, (body) => {
        noteInto(body, lobe.note, 'lamp-note');
        const made = [
          control(body, {
            kind: 'range',
            label: 'Intensity',
            min: 0,
            max: 80,
            step: 0.1,
            get: () => state.lobes[index].intensity,
            set: (value) => (state.lobes[index].intensity = Number(value)),
            format: (value) => number(value, 1),
          }),
          control(body, {
            kind: 'range',
            label: 'Tightness (cone)',
            min: 1,
            max: 120,
            step: 0.5,
            get: () => state.lobes[index].tightness,
            set: (value) => (state.lobes[index].tightness = Number(value)),
            format: (value) => number(value, 1),
          }),
        ];

        const triple = document.createElement('div');
        triple.className = 'triple';
        ['x', 'y', 'z'].forEach((axis, axisIndex) => {
          const cell = document.createElement('div');
          const caption = document.createElement('span');
          caption.textContent = `dir ${axis}`;
          const field = document.createElement('input');
          field.type = 'number';
          field.step = '0.01';
          field.value = String(state.lobes[index].direction[axisIndex]);
          field.addEventListener('change', () => {
            const parsed = Number(field.value);
            if (Number.isFinite(parsed)) {
              state.lobes[index].direction[axisIndex] = parsed;
              applyAll();
            }
          });
          cell.appendChild(caption);
          cell.appendChild(field);
          triple.appendChild(cell);
        });
        body.appendChild(triple);

        // The lamp colors are LINEAR radiance multipliers, not sRGB, so the
        // swatch is a convenience that writes linear values back. Untouched, the
        // state keeps build-coin.py's exact numbers rather than a round trip
        // through eight bits.
        made.push(
          control(body, {
            kind: 'colour',
            label: 'Tint',
            get: () => linearToHex(state.lobes[index].colour),
            set: (value) => (state.lobes[index].colour = hexToLinear(value)),
          }),
        );
        return made;
      }),
    );
  });
}

function linearToHex(colour) {
  const channel = (value) => {
    const srgb =
      value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(Math.max(value, 0), 1 / 2.4) - 0.055;
    return Math.round(Math.min(Math.max(srgb, 0), 1) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${colour.map(channel).join('')}`;
}

function hexToLinear(hex) {
  const bytes = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  return bytes.map((value) =>
    value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4),
  );
}
