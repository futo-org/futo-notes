// The studio the gold reflects, as a function rather than a file.
//
// `assets/coin/build-coin.py` writes `studio-env.hdr` from about thirty lines of
// numpy. This is that arithmetic in JavaScript, so the coin tuner
// (`just coin-tuner`) can rebuild the room live while a slider moves instead of
// shelling out to Blender per frame.
//
// It is therefore a SECOND copy of the studio (scripts/drift-registry.json,
// concept `coin-studio-environment`) — and a locked one: `just coin-check`
// rebuilds the room with the defaults below, decodes the shipped .hdr, and
// fails if the two disagree by more than the file format's own rounding. A
// change to the Python that was not mirrored here goes red before it can make
// the tuner show you a coin nobody is shipping.
//
// No node-only imports: the browser loads this file directly.

/// The room and its lamps, exactly as build-coin.py has them. Editing these is
/// how the gate stops passing, so the numbers move here and in the Python
/// together or not at all.
export const SHIPPED = {
  /// Equirectangular map size. Every engine prefilters this into irradiance and
  /// a roughness mip chain, so detail beyond this is thrown away immediately.
  width: 256,
  height: 128,
  room: {
    /// The light that is everywhere, so nothing is ever pure black.
    ambient: [0.07, 0.074, 0.086],
    /// A soft bright ceiling. The coin's base brightness at every angle.
    sky: [2.05, 2.11, 2.32],
    /// How much the floor takes back out.
    floor: [0.045, 0.046, 0.052],
    skyExponent: 1.4,
    floorExponent: 1.2,
    /// Nothing in the room is darker than this.
    minimum: 0.004,
  },
  /// Each lobe is a lamp: where it is, how tight its cone, how hard it burns,
  /// and its colour. Directions are in the SHELL's frame — +Z out of the coin's
  /// face toward the viewer, +Y up the spindle.
  lobes: [
    {
      name: 'front box',
      note: 'Broad, up and to the left. Without something behind the viewer a face-on metal disc mirrors an empty room, so this is what makes the coin gold at all.',
      direction: [-0.3, 0.42, 0.86],
      tightness: 2.6,
      intensity: 6.4,
      colour: [1.0, 0.985, 0.95],
    },
    {
      name: 'key',
      note: 'High and right, angled at the edge so its reflection sweeps across the face as the coin turns rather than sitting still on it.',
      direction: [0.8, 0.52, 0.3],
      tightness: 18.0,
      intensity: 24.0,
      colour: [1.0, 0.97, 0.9],
    },
    {
      name: 'right box',
      note: 'A second broad box, so the three-quarter angles keep a body of light instead of going muddy brown.',
      direction: [0.55, 0.3, 0.78],
      tightness: 3.0,
      intensity: 4.6,
      colour: [1.0, 0.96, 0.9],
    },
    {
      name: 'fill',
      note: 'Low, left and cool, so the shaded half reads as shadowed metal rather than as a hole.',
      direction: [-0.85, -0.22, 0.48],
      tightness: 4.0,
      intensity: 3.2,
      colour: [0.8, 0.86, 1.0],
    },
    {
      name: 'kicker',
      note: 'Small and hot, behind and above, purely so the bevel has a travelling spark. The tightest lamp here, and the one most likely to blow out.',
      direction: [-0.25, 0.62, -0.75],
      tightness: 70.0,
      intensity: 46.0,
      colour: [1.0, 0.93, 0.8],
    },
  ],
};

/// A deep copy of the shipped studio, safe to mutate.
export function shippedStudio() {
  return structuredClone(SHIPPED);
}

/**
 * The studio as linear RGB floats, row-major from the TOP of the image (the
 * first scanline is straight up) — the convention three.js, Filament and USD
 * all read.
 *
 * Returns `{ width, height, data }` where `data` is a Float32Array of
 * `width * height * 3` radiance values. Nothing here is clamped to 1: these are
 * lamps, and the whole point of an HDR environment is that they are brighter
 * than white.
 */
export function buildStudioEnvironment(studio = SHIPPED) {
  const { width, height } = studio;
  const { ambient, sky, floor, skyExponent, floorExponent, minimum } = studio.room;
  const data = new Float32Array(width * height * 3);

  // Precompute the lamps' unit directions once rather than per pixel.
  const lamps = studio.lobes.map((lobe) => {
    const [x, y, z] = lobe.direction;
    const length = Math.hypot(x, y, z);
    return {
      nx: x / length,
      ny: y / length,
      nz: z / length,
      tightness: lobe.tightness,
      intensity: lobe.intensity,
      colour: lobe.colour,
    };
  });

  for (let row = 0; row < height; row += 1) {
    // v runs down the image, so elevation runs from +pi/2 on the first row.
    const elevation = (0.5 - (row + 0.5) / height) * Math.PI;
    const cosElevation = Math.cos(elevation);
    const dy = Math.sin(elevation);

    // The room is a function of height alone, so it is the same across a row.
    const up = Math.min(Math.max(dy, -1), 1);
    const skyAmount = Math.pow(Math.max(up, 0), skyExponent);
    const floorAmount = Math.pow(Math.max(-up, 0), floorExponent);
    const base = [0, 1, 2].map((channel) =>
      Math.max(ambient[channel] + sky[channel] * skyAmount - floor[channel] * floorAmount, minimum),
    );

    for (let column = 0; column < width; column += 1) {
      const longitude = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
      const dx = Math.cos(longitude) * cosElevation;
      const dz = Math.sin(longitude) * cosElevation;

      let r = base[0];
      let g = base[1];
      let b = base[2];
      for (const lamp of lamps) {
        const facing = dx * lamp.nx + dy * lamp.ny + dz * lamp.nz;
        if (facing <= 0) continue;
        const lobe = Math.pow(facing, lamp.tightness) * lamp.intensity;
        r += lobe * lamp.colour[0];
        g += lobe * lamp.colour[1];
        b += lobe * lamp.colour[2];
      }

      const at = (row * width + column) * 3;
      data[at] = r;
      data[at + 1] = g;
      data[at + 2] = b;
    }
  }

  return { width, height, data };
}

/**
 * Decode a flat (un-run-length-encoded) Radiance .hdr into linear RGB floats.
 *
 * Only what build-coin.py writes is supported: a `#?RADIANCE` header, a
 * `-Y <height> +X <width>` resolution line, and raw RGBE bytes. That is the
 * gate's whole job — read back the file the Python produced and compare it to
 * what the port above produces.
 */
export function decodeRadianceHdr(bytes) {
  let cursor = 0;
  const readLine = () => {
    const start = cursor;
    while (cursor < bytes.length && bytes[cursor] !== 0x0a) cursor += 1;
    const line = new TextDecoder().decode(bytes.subarray(start, cursor));
    cursor += 1;
    return line;
  };

  if (!readLine().startsWith('#?RADIANCE')) throw new Error('not a Radiance .hdr');
  let line = readLine();
  while (line.trim() !== '') {
    if (line.startsWith('FORMAT=') && !line.includes('32-bit_rle_rgbe')) {
      throw new Error(`unsupported .hdr format: ${line}`);
    }
    line = readLine();
  }

  const resolution = /^-Y (\d+) \+X (\d+)$/.exec(readLine());
  if (resolution === null) throw new Error('unsupported .hdr resolution line');
  const height = Number(resolution[1]);
  const width = Number(resolution[2]);

  const pixels = width * height;
  if (bytes.length - cursor !== pixels * 4) {
    throw new Error('run-length-encoded .hdr scanlines are not supported');
  }

  const data = new Float32Array(pixels * 3);
  // The smallest step this pixel could have recorded. It falls out of the
  // shared exponent, so it is exact — deriving it from the decoded values
  // instead would be off by up to a factor of two, because RGBE's mantissa
  // lives in [0.5, 1).
  const quantum = new Float32Array(pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const at = cursor + pixel * 4;
    const exponent = bytes[at + 3];
    // An exponent of 0 is the format's exact zero.
    const scale = exponent === 0 ? 0 : Math.pow(2, exponent - 128) / 256;
    quantum[pixel] = scale;
    data[pixel * 3] = bytes[at] * scale;
    data[pixel * 3 + 1] = bytes[at + 1] * scale;
    data[pixel * 3 + 2] = bytes[at + 2] * scale;
  }

  return { width, height, data, quantum };
}

/**
 * How far a decoded .hdr is from a freshly built studio, in units of the file
 * format's own rounding.
 *
 * RGBE keeps one shared exponent and eight bits per channel, so each pixel has
 * a smallest step it could possibly have recorded, and build-coin.py TRUNCATES
 * to it rather than rounding. A result below 1 therefore means the two agree as
 * closely as the file can record; 1 or above is a real difference in the
 * arithmetic.
 */
export function compareToHdr(built, decoded) {
  if (built.width !== decoded.width || built.height !== decoded.height) {
    throw new Error(
      `size mismatch: built ${built.width}x${built.height}, file ${decoded.width}x${decoded.height}`,
    );
  }
  let worst = 0;
  let worstAt = 0;
  for (let pixel = 0; pixel < built.width * built.height; pixel += 1) {
    const at = pixel * 3;
    const quantum = Math.max(decoded.quantum[pixel], Number.MIN_VALUE);
    for (let channel = 0; channel < 3; channel += 1) {
      const error = Math.abs(built.data[at + channel] - decoded.data[at + channel]) / quantum;
      if (error > worst) {
        worst = error;
        worstAt = pixel;
      }
    }
  }
  return {
    worst,
    row: Math.floor(worstAt / built.width),
    column: worstAt % built.width,
  };
}
