// A hundred-odd little coins, bouncing around inside the License plate.
//
// FUTOpay's checkout page does this on a purchase (`coin-bounce.js` in
// lib-polar), and @justin asked for the same moment here. That one is a
// cannon-es rigid-body world covering the whole browser window; this one is
// deliberately not:
//
//   - **Confined.** The canvas is the plate's own box and the coins bounce off
//     its four walls, so the celebration belongs to the thing being celebrated
//     rather than raining over the notes behind the Settings sheet.
//   - **No physics engine.** Ballistic motion plus a coefficient of restitution
//     is the whole model. A rigid-body dependency buys tumbling contact
//     resolution that nothing here can see at this size, and it would land in
//     the bundle of an app whose editor budget is measured per keystroke.
//   - **No second WebGL context.** `supporterCoin.ts` warns that a document has
//     a small fixed pool of them; the 3D coin in the well is already holding
//     one. A 2D canvas costs none.
//
// It runs for a few seconds in Settings — a surface the user opened on purpose —
// and stops itself completely afterwards (M5: nothing animates in the
// background).

/// How many coins the burst throws. The FUTOpay page spawns one per click and
/// lets them pile up; this is the whole pile at once.
const COIN_COUNT = 120;

/// Pixels per second squared. Tuned against the plate's height rather than a
/// real g: what matters is that a coin thrown at the top of the plate comes back
/// down within about a second.
const GRAVITY = 1500;

/// Opening speed, in pixels per second. The spread is wide on purpose — a
/// uniform burst reads as a mechanism, an uneven one as a handful of coins.
const SPEED_MIN = 260;
const SPEED_MAX = 760;

/// How much speed survives a bounce. High on purpose: the plate is only a few
/// hundred pixels tall, so a realistic 0.4 has every coin parked in under a
/// second and the whole thing reads as a pile rather than as coins bouncing
/// around.
const WALL_RESTITUTION = 0.62;
const FLOOR_RESTITUTION = 0.66;
/// Horizontal speed lost on each floor contact, so coins drift rather than
/// skating the full width forever.
const FLOOR_FRICTION = 0.9;
/// Below this vertical speed a coin touching its rest line is laid down rather
/// than bounced again — otherwise it buzzes at sub-pixel amplitudes forever.
const REST_SPEED = 55;
/// How far above the floor a coin may come to rest. Nothing here collides with
/// anything else, so without this every coin parks on the same line and 120 of
/// them read as a gold rule drawn along the bottom edge. Scattering the rest
/// line is what makes them look heaped.
const REST_SCATTER = 26;

/// Radians per second of tumble. A coin is drawn edge-on as it passes through
/// a quarter turn, which is the whole reason it reads as a coin and not a dot.
const TUMBLE_MIN = 6;
const TUMBLE_MAX = 22;

const RADIUS_MIN = 5;
const RADIUS_MAX = 9;

/// How long the coins stay before they start to go, and how long they take.
/// Short enough that most are still in the air when the fade starts — a burst
/// that outlives its own motion is just clutter on the plate.
const SETTLE_MS = 2300;
const FADE_MS = 900;

/// Frame-time clamp, the same reason `supporterCoin.ts` has one: a hidden tab
/// hands back a huge first delta, and a 300ms step would teleport every coin
/// through a wall.
const MAX_FRAME_SECONDS = 1 / 30;

/// Gold, matching the coin in the well and the plate's accent.
const FACE_LIGHT = '#ffd24d';
const FACE_DARK = '#c8920c';
const RIM = '#8b6508';
/// The FUTO diamond punched through the middle, as a fraction of the radius.
/// The same 0.45 the Blender model and all three flat glyphs use.
const DIAMOND_HALF = 0.45;

interface Coin {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /// Where the coin is in its tumble. `cos(phase)` is how much of its face is
  /// turned toward us, so 0 is face-on and a quarter turn is edge-on.
  phase: number;
  tumble: number;
  /// The tilt of the spin axis in the plane, so they do not all tumble about
  /// the same horizontal line.
  tilt: number;
  /// The y this coin settles on, scattered so the heap has depth.
  restY: number;
  resting: boolean;
}

function between(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/// Throws a burst of coins across `host` and returns a function that stops and
/// removes them. Returns `null` when there is nothing to draw on — a zero-sized
/// host, or a browser with no 2D context.
///
/// The caller owns the teardown: the shower also ends on its own once every coin
/// has faded, and calling the returned function after that is harmless.
export function startCoinShower(host: HTMLElement): (() => void) | null {
  const width = host.clientWidth;
  const height = host.clientHeight;
  if (width === 0 || height === 0) return null;

  const canvas = document.createElement('canvas');
  const maybeContext = canvas.getContext('2d');
  if (maybeContext === null) return null;
  // Aliased after the guard: the painters below are hoisted function
  // declarations, and TypeScript does not carry a narrowing into those.
  const context = maybeContext;

  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  // The canvas covers the plate and must never eat a click meant for the Buy
  // button or the coin underneath it.
  canvas.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:1';
  context.scale(ratio, ratio);
  host.appendChild(canvas);

  // Out of the coin itself when there is one, so the burst reads as coming from
  // the thing that was just earned; the middle of the plate otherwise, which is
  // where the coin is about to appear. Everything is thrown upward — coins that
  // started downward simply bounced once and looked like they had been dropped.
  const well = host.querySelector('.license-well');
  const plateBox = host.getBoundingClientRect();
  const wellBox = well?.getBoundingClientRect();
  const originX =
    wellBox === undefined ? width / 2 : wellBox.left - plateBox.left + wellBox.width / 2;
  const originY =
    wellBox === undefined ? height / 2 : wellBox.top - plateBox.top + wellBox.height / 2;
  const coins: Coin[] = Array.from({ length: COIN_COUNT }, () => {
    const angle = between(Math.PI * 1.15, Math.PI * 1.85);
    const speed = between(SPEED_MIN, SPEED_MAX);
    return {
      x: originX + between(-12, 12),
      y: originY + between(-12, 12),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      radius: between(RADIUS_MIN, RADIUS_MAX),
      phase: Math.random() * Math.PI * 2,
      tumble: between(TUMBLE_MIN, TUMBLE_MAX) * (Math.random() < 0.5 ? -1 : 1),
      tilt: between(-0.5, 0.5),
      restY: between(0, REST_SCATTER),
      resting: false,
    };
  });

  let frame = 0;
  let last = 0;
  let elapsed = 0;
  let stopped = false;

  function advance(coin: Coin, seconds: number): void {
    if (!coin.resting) {
      coin.vy += GRAVITY * seconds;
      coin.x += coin.vx * seconds;
      coin.y += coin.vy * seconds;
      coin.phase += coin.tumble * seconds;
    }

    // Walls. Position is corrected as well as velocity, so a coin that
    // overshot in one step cannot be caught outside and bounced every frame.
    if (coin.x - coin.radius < 0) {
      coin.x = coin.radius;
      coin.vx = Math.abs(coin.vx) * WALL_RESTITUTION;
    } else if (coin.x + coin.radius > width) {
      coin.x = width - coin.radius;
      coin.vx = -Math.abs(coin.vx) * WALL_RESTITUTION;
    }
    if (coin.y - coin.radius < 0) {
      coin.y = coin.radius;
      coin.vy = Math.abs(coin.vy) * WALL_RESTITUTION;
    }

    const floor = height - coin.radius - coin.restY;
    if (coin.y >= floor) {
      coin.y = floor;
      if (Math.abs(coin.vy) < REST_SPEED) {
        // Laid flat, face up, and left alone.
        coin.resting = true;
        coin.vx = 0;
        coin.vy = 0;
        coin.phase = 0;
      } else {
        coin.vy = -Math.abs(coin.vy) * FLOOR_RESTITUTION;
        coin.vx *= FLOOR_FRICTION;
        coin.tumble *= FLOOR_FRICTION;
      }
    }
  }

  function paint(coin: Coin): void {
    // `cos(phase)` is how much of the face is turned toward us. Squashing the
    // disc by it is the whole tumble: at a quarter turn the coin is a line, and
    // what is left is its rim.
    const facing = Math.abs(Math.cos(coin.phase));
    context.save();
    context.translate(coin.x, coin.y);
    context.rotate(coin.tilt);

    // The rim, drawn first and slightly proud of the face, so an edge-on coin
    // is a bright gold sliver rather than nothing at all.
    context.beginPath();
    context.ellipse(0, 0, coin.radius, Math.max(coin.radius * facing, 0.6), 0, 0, Math.PI * 2);
    context.fillStyle = RIM;
    context.fill();

    if (facing > 0.12) {
      const face = context.createLinearGradient(
        -coin.radius,
        -coin.radius,
        coin.radius,
        coin.radius,
      );
      face.addColorStop(0, FACE_LIGHT);
      face.addColorStop(1, FACE_DARK);
      context.beginPath();
      context.ellipse(0, 0, coin.radius * 0.88, coin.radius * facing * 0.88, 0, 0, Math.PI * 2);
      context.fillStyle = face;
      context.fill();

      // The FUTO diamond. Shaded rather than punched: a real hole would have to
      // show whatever is behind this coin, and at eight pixels across a dark
      // recess reads the same and costs one path.
      const half = coin.radius * DIAMOND_HALF;
      context.beginPath();
      context.moveTo(0, -half * facing);
      context.lineTo(half, 0);
      context.lineTo(0, half * facing);
      context.lineTo(-half, 0);
      context.closePath();
      context.fillStyle = RIM;
      context.fill();
    }

    context.restore();
  }

  function step(now: number): void {
    if (stopped) return;
    const seconds = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
    last = now;
    elapsed += seconds * 1000;

    context.clearRect(0, 0, width, height);
    context.globalAlpha =
      elapsed <= SETTLE_MS ? 1 : Math.max(0, 1 - (elapsed - SETTLE_MS) / FADE_MS);

    for (const coin of coins) {
      advance(coin, seconds);
      paint(coin);
    }

    if (elapsed >= SETTLE_MS + FADE_MS) {
      stop();
      return;
    }
    frame = requestAnimationFrame(step);
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (frame !== 0) cancelAnimationFrame(frame);
    frame = 0;
    canvas.remove();
  }

  frame = requestAnimationFrame(step);
  return stop;
}
