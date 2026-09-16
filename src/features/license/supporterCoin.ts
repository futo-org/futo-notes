// The FUTO coin, in three dimensions.
//
// Geometry and materials are the ones from the FUTOpay storefront's
// `coin-bounce.js` (lib-polar, `pylib/futopay_server/static/js/coin-bounce.js`):
// a disc with the FUTO diamond punched clean through it, extruded flat, gold
// face over a darker rim. What is NOT carried over is that file's cannon-es
// physics world — the storefront throws coins around the window, and this is
// one coin on a spindle, so a rigid-body solver would be dead weight.
//
// three.js is imported dynamically by the only caller (SupporterCoin.svelte).
// Keeping the import here, behind a function, is what keeps it off the
// cold-start path: Rollup gives an `import()`-only dependency its own chunk
// (vite.config.ts `manualChunks` explains why naming it would undo that).

/// Straight from coin-bounce.js so the coin is recognisably the same object.
const OUTER_RADIUS = 0.35;
const DEPTH = OUTER_RADIUS / 6;
const DIAMOND_HALF = OUTER_RADIUS * 0.45;
const CORNER_RADIUS = Math.min(OUTER_RADIUS * 0.16, DIAMOND_HALF * 0.7);
const CURVE_SEGMENTS = 96;

const FACE_COLOR = 0xffbb00;
const FACE_EMISSIVE = 0xffc800;
const RIM_COLOR = 0xb8860b;
const EDGE_COLOR = 0x8b7500;

/// Slow enough to read as an object rather than a spinner: one turn every ~5s.
const BASE_SPIN = 1.25;
/// A key was accepted. Fast, then back down to the resting speed within a
/// couple of seconds — a moment, not a new resting state.
const CELEBRATION_SPIN = 16;
/// How fast any departure from the resting speed — a celebration, a flick —
/// bleeds off. One constant, so a thrown coin and a celebrating one settle the
/// same way.
const SPIN_DECAY = 2.6;

/// Radians of turn per pixel dragged. Tuned so crossing a 96px coin turns it
/// about half a revolution: enough that a drag obviously grabs the object,
/// little enough that you can stop on a face.
const DRAG_RADIANS_PER_PIXEL = 0.018;
/// A flick is only a flick if the pointer was still moving when it left. Below
/// this the coin is *placed*, and it stays where it was put until it eases back
/// to its resting speed.
const FLICK_MIN_SPEED = 0.6;
/// Ceiling on a thrown spin, so a fast swipe across a trackpad cannot turn the
/// coin into a strobe.
const FLICK_MAX_SPEED = 24;

/// A fixed tilt, so the coin is read as a disc even at the instant its face is
/// edge-on to the camera.
const TILT_X = 0.24;

/// Vertical field of view for a square box. `frameShortSide` widens it when the
/// box is taller than it is wide.
const BASE_FOV = 30;

/// Frame-time clamp. A backgrounded tab hands back a huge delta on its first
/// frame; without this the coin jumps a random fraction of a turn on return.
const MAX_FRAME_SECONDS = 1 / 20;

export interface CoinHandle {
  /// Sets whether the coin turns on its own. Stopped it still renders, and it
  /// can still be dragged — `prefers-reduced-motion` asks for no unrequested
  /// animation, not for a dead object.
  setSpinning(spinning: boolean): void;
  /// Spins it up once; decays back to the resting speed on its own.
  celebrate(): void;
  /// True while a pointer is turning the coin. Exposed for tests and for a
  /// caller that must not fight the user's hand.
  isPointerDown(): boolean;
  dispose(): void;
}

/// Builds the coin into `mount` and keeps it filling that element, or resolves
/// `null` when this browser cannot give us a WebGL context. Never throws for a
/// missing context — the caller has a flat coin to fall back to and the user
/// should not notice.
export async function buildCoin(mount: HTMLElement): Promise<CoinHandle | null> {
  const THREE = await import('three');

  let renderer: import('three').WebGLRenderer;
  try {
    // `preserveDrawingBuffer` is what makes the coin survive a `toDataURL()`
    // read-back — without it every screenshot of this app captures the coin as
    // a transparent hole, including the QA bridge's (Linux has no native
    // window capture, so it composites the DOM). coin-bounce.js sets it too.
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    });
  } catch {
    return null;
  }

  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  const canvas = renderer.domElement;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  mount.appendChild(canvas);

  const scene = new THREE.Scene();

  // Framed so the coin fills the box without its corners clipping as it turns.
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 10);
  camera.position.set(0, 0, 1.55);
  camera.lookAt(0, 0, 0);

  // The element owns the size. A box that is not square keeps the coin round
  // and centred rather than stretching it, because the camera always frames the
  // SHORTER side. A zero-sized box (display:none, or an observer that fires
  // before layout) is skipped — WebGL rejects a zero-wide drawing buffer.
  function resize(): void {
    const width = Math.round(mount.clientWidth);
    const height = Math.round(mount.clientHeight);
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    const aspect = width / height;
    camera.aspect = aspect;
    // `fov` is the VERTICAL angle, so a wide box needs no change and a tall one
    // has to widen vertically until the horizontal angle is back to BASE_FOV.
    camera.fov =
      aspect >= 1
        ? BASE_FOV
        : (2 * Math.atan(Math.tan((BASE_FOV * Math.PI) / 360) / aspect) * 180) / Math.PI;
    camera.updateProjectionMatrix();
    draw();
  }

  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(1.2, 1.4, 2);
  scene.add(key);
  scene.add(new THREE.AmbientLight(0x404040, 0.5));

  const { coin, disposeCoin } = buildCoinObject(THREE);
  scene.add(coin);

  let spin = BASE_SPIN;
  let spinning = false;
  let dragging = false;
  let frame = 0;
  let last = 0;
  let disposed = false;

  /// What the coin eases back to when nothing is acting on it. Zero under
  /// reduced motion, so a flick still settles — it just settles to a stop.
  function restSpin(): number {
    return spinning ? BASE_SPIN : 0;
  }

  function draw(): void {
    renderer.render(scene, camera);
  }

  function step(now: number): void {
    if (disposed) return;
    frame = requestAnimationFrame(step);
    const elapsed = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
    last = now;

    // While a finger is down the pointer owns the angle outright: the coin
    // tracks the hand exactly rather than being nudged by a velocity, which is
    // what makes it feel like an object and not a dial.
    if (!dragging) {
      const rest = restSpin();
      // Eases in from either side, so a backwards flick settles as gracefully
      // as a celebration spins down.
      spin = rest + (spin - rest) * Math.exp(-SPIN_DECAY * elapsed);
      coin.rotation.y += spin * elapsed;
    }
    draw();
  }

  function start(): void {
    if (disposed || frame !== 0) return;
    last = 0;
    frame = requestAnimationFrame(step);
  }

  function stop(): void {
    if (frame === 0) return;
    cancelAnimationFrame(frame);
    frame = 0;
  }

  // Off-screen or in a hidden window, a spinning coin is pure cost. The editor
  // is one keystroke away from every surface this thing appears on (M5), so it
  // does not get to run while nobody can see it.
  function sync(): void {
    if (!onScreen || document.visibilityState !== 'visible') {
      stop();
      return;
    }
    // Keep stepping while a drag is live or while a flick is still bleeding
    // off, even when the coin does not turn on its own — otherwise a thrown
    // coin freezes mid-air the moment the pointer lifts.
    if (spinning || dragging || Math.abs(spin - restSpin()) > 0.01) start();
    else stop();
  }

  let onScreen = true;
  const observer =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          onScreen = entries.some((entry) => entry.isIntersecting);
          sync();
        })
      : null;
  observer?.observe(mount);

  const onVisibility = (): void => sync();
  document.addEventListener('visibilitychange', onVisibility);

  // Grab it and turn it. The controller owns the pointer bookkeeping; this
  // just says what a turn and a release mean for the coin.
  const detachDrag = attachDragToTurn(mount, {
    grab: () => {
      dragging = true;
      sync();
    },
    turnBy: (radians) => {
      coin.rotation.y += radians;
      draw();
    },
    // `thrown` is null when the pointer was resting as it lifted: the coin was
    // placed, and eases back to its resting speed from wherever it was put.
    release: (thrown) => {
      dragging = false;
      spin = thrown === null ? restSpin() : thrown;
      sync();
    },
  });

  // The card's height depends on its text, which depends on the license state,
  // so the box this coin lives in changes size after it is built.
  const resizeObserver =
    typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  resizeObserver?.observe(mount);

  // Size and draw once immediately, so the coin is there before the first rAF
  // and the reduced-motion path renders something rather than an empty canvas.
  resize();

  return {
    setSpinning(next: boolean): void {
      spinning = next;
      sync();
    },
    isPointerDown(): boolean {
      return dragging;
    },
    celebrate(): void {
      spin = CELEBRATION_SPIN;
      sync();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop();
      observer?.disconnect();
      resizeObserver?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      detachDrag();
      disposeCoin();
      renderer.dispose();
      // WebGL contexts are a small, fixed pool per document; dropping the
      // canvas alone does not give one back.
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

/// The coin itself: geometry, its two gold materials and the edge overlay,
/// grouped and tilted. Returns the group plus the one call that frees all of
/// it — three.js does not track these for you, and a Settings sheet that is
/// opened and closed all day would otherwise leak a mesh per visit.
function buildCoinObject(THREE: typeof import('three')): {
  coin: import('three').Group;
  disposeCoin: () => void;
} {
  const { geometry, edges } = buildCoinGeometry(THREE);

  // Two groups come out of ExtrudeGeometry — the faces, then the extruded
  // wall — so the materials array is [face, rim] in that order.
  const face = new THREE.MeshStandardMaterial({
    color: FACE_COLOR,
    metalness: 1,
    roughness: 0.08,
    emissive: FACE_EMISSIVE,
    // Metal with no environment map reflects nothing, so the face would read
    // black without this. The storefront coin solves it the same way.
    emissiveIntensity: 0.88,
    side: THREE.DoubleSide,
  });
  const rim = new THREE.MeshStandardMaterial({
    color: RIM_COLOR,
    metalness: 0.7,
    roughness: 0.5,
  });
  const edgeMaterial = new THREE.LineBasicMaterial({ color: EDGE_COLOR });

  const coin = new THREE.Group();
  coin.add(new THREE.Mesh(geometry, [face, rim]));
  coin.add(new THREE.LineSegments(edges, edgeMaterial));
  coin.rotation.x = TILT_X;

  return {
    coin,
    disposeCoin: () => {
      geometry.dispose();
      edges.dispose();
      face.dispose();
      rim.dispose();
      edgeMaterial.dispose();
    },
  };
}

/// What a drag does to the thing being turned.
interface TurnTarget {
  grab(): void;
  turnBy(radians: number): void;
  /// Angular velocity in rad/s for a flick, or `null` when the coin was placed
  /// rather than thrown.
  release(thrown: number | null): void;
}

/// Makes an element's contents turn under a mouse, pen or finger, and returns
/// the detach function.
///
/// Pointer events cover all three input kinds in one path, and pointer capture
/// means a drag that wanders off the element keeps tracking instead of
/// sticking. `touch-action: pan-y` is a deliberate half-measure: a vertical
/// swipe still scrolls the Settings sheet under the finger, a horizontal one
/// turns the coin. Claiming the whole gesture would trap the scroll on a phone.
function attachDragToTurn(mount: HTMLElement, target: TurnTarget): () => void {
  let pointer = -1;
  let lastX = 0;
  let lastMoveAt = 0;
  /// Radians/second, smoothed — a single sample is noisy enough to throw a wild
  /// flick off the last two pixels of an otherwise slow drag.
  let velocity = 0;

  mount.style.touchAction = 'pan-y';
  // The cursor is NOT set here. `src/styles/desktop-native.css` owns cursor
  // policy for the whole desktop shell with a layered `!important` sweep, so an
  // inline cursor silently loses to it; the grab/grabbing pair is declared
  // there, keyed off this attribute.
  mount.dataset.turning = 'false';

  function onPointerDown(event: PointerEvent): void {
    if (pointer !== -1) return;
    pointer = event.pointerId;
    lastX = event.clientX;
    lastMoveAt = event.timeStamp;
    velocity = 0;
    // Capture keeps a drag tracking after it wanders off the coin. It throws
    // for a pointer id the browser does not consider active — a synthetic
    // event from a test, or a pointer already released — and losing capture is
    // not worth losing the drag over.
    try {
      mount.setPointerCapture(event.pointerId);
    } catch {
      /* drag still works, it just stops at the element's edge */
    }
    mount.dataset.turning = 'true';
    target.grab();
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.pointerId !== pointer) return;
    const dx = event.clientX - lastX;
    const seconds = (event.timeStamp - lastMoveAt) / 1000;
    lastX = event.clientX;
    lastMoveAt = event.timeStamp;
    const radians = dx * DRAG_RADIANS_PER_PIXEL;
    target.turnBy(radians);
    if (seconds > 0) velocity = velocity * 0.7 + (radians / seconds) * 0.3;
  }

  function endDrag(event: PointerEvent): void {
    if (event.pointerId !== pointer) return;
    pointer = -1;
    mount.dataset.turning = 'false';
    // A stale sample would fling a coin the user had deliberately held still,
    // so a pointer that had stopped before it lifted counts as a placement.
    const stale = event.timeStamp - lastMoveAt > 100;
    const thrown = !stale && Math.abs(velocity) > FLICK_MIN_SPEED;
    target.release(thrown ? Math.max(-FLICK_MAX_SPEED, Math.min(FLICK_MAX_SPEED, velocity)) : null);
  }

  mount.addEventListener('pointerdown', onPointerDown);
  mount.addEventListener('pointermove', onPointerMove);
  mount.addEventListener('pointerup', endDrag);
  mount.addEventListener('pointercancel', endDrag);

  return () => {
    mount.removeEventListener('pointerdown', onPointerDown);
    mount.removeEventListener('pointermove', onPointerMove);
    mount.removeEventListener('pointerup', endDrag);
    mount.removeEventListener('pointercancel', endDrag);
  };
}

/// The disc-with-a-diamond-hole profile, extruded. Ported from
/// `createSharedCoinResources()` in coin-bounce.js; the storefront then lays
/// the coin flat for its physics world, which is the one step dropped here.
function buildCoinGeometry(THREE: typeof import('three')): {
  geometry: import('three').ExtrudeGeometry;
  edges: import('three').EdgesGeometry;
} {
  const profile = new THREE.Shape();
  profile.moveTo(OUTER_RADIUS, 0);
  profile.absarc(0, 0, OUTER_RADIUS, 0, Math.PI * 2, false);

  const top = new THREE.Vector2(0, DIAMOND_HALF);
  const left = new THREE.Vector2(-DIAMOND_HALF, 0);
  const bottom = new THREE.Vector2(0, -DIAMOND_HALF);
  const right = new THREE.Vector2(DIAMOND_HALF, 0);

  // Each corner is a quadratic through the diamond's point, started and ended
  // CORNER_RADIUS back along the two edges that meet there.
  const towards = (from: import('three').Vector2, to: import('three').Vector2) => {
    const direction = new THREE.Vector2().subVectors(to, from).setLength(CORNER_RADIUS);
    return new THREE.Vector2(from.x + direction.x, from.y + direction.y);
  };

  const hole = new THREE.Path();
  const startAt = towards(top, left);
  hole.moveTo(startAt.x, startAt.y);
  for (const [corner, next] of [
    [top, right],
    [right, bottom],
    [bottom, left],
    [left, top],
  ] as const) {
    const after = towards(corner, next);
    hole.quadraticCurveTo(corner.x, corner.y, after.x, after.y);
    const before = towards(next, corner);
    hole.lineTo(before.x, before.y);
  }
  hole.closePath();
  profile.holes.push(hole);

  const geometry = new THREE.ExtrudeGeometry(profile, {
    depth: DEPTH,
    bevelEnabled: false,
    curveSegments: CURVE_SEGMENTS,
  });
  // Centre it on Z so it turns about its own axis rather than orbiting one.
  geometry.translate(0, 0, -DEPTH / 2);

  return { geometry, edges: new THREE.EdgesGeometry(geometry) };
}
