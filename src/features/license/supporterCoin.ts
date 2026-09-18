// The FUTO coin, in three dimensions.
//
// The coin itself is NOT built here. It is modelled once in Blender by
// `assets/coin/build-coin.py` and exported to `futo-coin.glb`, which this file,
// the native iOS shell and the native Android shell all render. That is the
// whole point of the Blender step: there is one object, and the three shells
// only frame it, light it and turn it.
//
// What lights it is `studio-env.hdr`, the small studio the same script writes.
// Gold is a metal, and a metal with nothing to reflect renders black — the
// version of this file that built its own geometry had to fake brightness with
// an `emissive` term, which is why it read as a sticker rather than as metal.
// With a real environment the material is honest and all three shells agree
// about what the coin is made of.
//
// three.js is imported dynamically by the only caller (SupporterCoin.svelte).
// Keeping the import here, behind a function, is what keeps it off the
// cold-start path: Rollup gives an `import()`-only dependency its own chunk
// (vite.config.ts `manualChunks` explains why naming it would undo that). The
// model and the environment are fetched on the same first visit, and until they
// land the flat SVG in SupporterCoin.svelte is what the user sees.

/// The Blender exports. `?url` keeps them out of the JS bundle: Vite emits them
/// as hashed files and hands back the path, so the coin costs nothing until a
/// licensed user opens Settings.
import coinModelUrl from '@/assets/coin/futo-coin.glb?url';
import coinEnvironmentUrl from '@/assets/coin/studio-env.hdr?url';

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

/// A click on the coin owes it one more full turn (@justin 2026-09-17).
/// Distinct from `celebrate()`, which is a spin-up the decay bleeds off and
/// which lands wherever it lands.
///
/// Clicks QUEUE, because what a click adds is an ANGLE and not a restart: ten
/// fast clicks are ten turns (@justin 2026-09-18). The first version of this
/// held a phase into a single half-second turn and set it back to zero on every
/// click, so a burst of clicks delivered one turn and swallowed the rest.
const TAP_TURN = Math.PI * 2;
/// How fast the debt is paid: radians per second for each radian still owed.
/// One turn owed opens at ~19 rad/s and is nine tenths paid in three quarters
/// of a second — the single-click turn the coin had before the queue.
const TAP_PAYOUT = 3;
/// Ceiling on the payout rate. Ten queued turns owe 63 radians, which without
/// this would open at 188 rad/s: three turns per frame, i.e. a coin that looks
/// stationary or strobing. Capped, a burst spins fast and keeps spinning until
/// every click has been paid.
const TAP_MAX_RATE = 26;
/// Floor on the payout rate, so the tail is a coast rather than an asymptote.
/// A purely proportional payout spends its last second turning the coin by
/// fractions of a degree — invisible, and it holds the render loop open. Just
/// above the resting spin, so the coin still reads as finishing something.
const TAP_MIN_RATE = 2;
/// Below this the rest of the debt is handed over in one frame: half a degree
/// is not a turn, and the debt has to actually reach zero.
const TAP_SETTLE = 0.01;
/// A press is a click and not a drag if the pointer barely moved and did not
/// linger. Both bounds matter: a 2px wobble is still a click, and a slow,
/// deliberate 2px nudge that holds for a second is not.
const TAP_MAX_MOVEMENT_PX = 5;
const TAP_MAX_MILLISECONDS = 400;

/// A fixed tilt, so the coin is read as a disc even at the instant its face is
/// edge-on to the camera. The native shells apply the same angle.
const TILT_X = 0.24;

/// Vertical field of view for a square box, and how far back the camera sits.
/// Together they frame the model's 0.7 diameter at about 84% of the shorter
/// side, which leaves room for the corners as it turns. `frameShortSide`
/// widens the angle when the box is taller than it is wide.
const BASE_FOV = 30;
const CAMERA_DISTANCE = 1.55;

/// Frame-time clamp. A backgrounded tab hands back a huge delta on its first
/// frame; without this the coin jumps a random fraction of a turn on return.
const MAX_FRAME_SECONDS = 1 / 20;

/// Exposure for the Khronos PBR Neutral tone map (see `openStage`).
const TONE_MAPPING_EXPOSURE = 1.0;

/// How much of an owed turn one frame pays off: fastest when the most is owed,
/// capped so a burst of clicks cannot become a strobe, and handing over the
/// last sliver whole so the debt actually reaches zero.
///
/// Exported for its test. Everything the queue promises — that ten clicks turn
/// the coin ten times, not once — is this function summing to exactly the debt
/// it was given.
export function tapTurnPayout(debt: number, seconds: number): number {
  if (debt <= 0) return 0;
  const rate = Math.min(Math.max(debt * TAP_PAYOUT, TAP_MIN_RATE), TAP_MAX_RATE);
  const paid = rate * seconds;
  return debt - paid <= TAP_SETTLE ? debt : paid;
}

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
/// The renderer plus everything loaded onto it: the model and the prefiltered
/// environment that lights it.
interface CoinStage {
  renderer: import('three').WebGLRenderer;
  model: import('three').Group;
  environment: import('three').Texture;
  environmentTarget: import('three').WebGLRenderTarget;
}

/// Opens a WebGL context and loads both assets onto it, or resolves `null` when
/// this browser cannot give us a context.
///
/// Both files or neither: a coin with its model but no environment would be a
/// black disc, which is worse than the flat SVG the caller already has up. A
/// load failure frees the context rather than leaving one of the document's
/// small fixed pool stranded, then rethrows so the caller can log it.
async function openStage(
  THREE: typeof import('three'),
  GLTFLoader: typeof import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader,
  RGBELoader: typeof import('three/examples/jsm/loaders/RGBELoader.js').RGBELoader,
): Promise<CoinStage | null> {
  let renderer: import('three').WebGLRenderer;
  try {
    // `preserveDrawingBuffer` is what makes the coin survive a `toDataURL()`
    // read-back — without it every screenshot of this app captures the coin as
    // a transparent hole, including the QA bridge's (Linux has no native
    // window capture, so it composites the DOM).
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
  // Khronos PBR Neutral, not ACES. ACES pushes a bright saturated highlight
  // toward white, which on this coin turns the gold sheen into a grey smear
  // exactly where it should be most golden. Neutral holds the hue.
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = TONE_MAPPING_EXPOSURE;

  try {
    const [gltf, equirect] = await Promise.all([
      new GLTFLoader().loadAsync(coinModelUrl),
      new RGBELoader().loadAsync(coinEnvironmentUrl),
    ]);
    equirect.mapping = THREE.EquirectangularReflectionMapping;
    // Prefilter once into the roughness mip chain the standard material
    // samples. Doing it here rather than per frame is the difference between a
    // coin that costs nothing to turn and one that re-blurs its world 60x a
    // second.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environmentTarget = pmrem.fromEquirectangular(equirect);
    equirect.dispose();
    pmrem.dispose();
    return {
      renderer,
      model: gltf.scene,
      environment: environmentTarget.texture,
      environmentTarget,
    };
  } catch (error) {
    renderer.dispose();
    renderer.forceContextLoss();
    throw error;
  }
}

export async function buildCoin(mount: HTMLElement): Promise<CoinHandle | null> {
  const [THREE, { GLTFLoader }, { RGBELoader }] = await Promise.all([
    import('three'),
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/loaders/RGBELoader.js'),
  ]);

  const stage = await openStage(THREE, GLTFLoader, RGBELoader);
  if (stage === null) return null;
  const { renderer, model, environment, environmentTarget } = stage;

  // Only now is there something worth showing, so only now does the canvas go
  // into the page. Appending it earlier would blank the flat SVG behind it for
  // as long as the two files take to arrive.
  const canvas = renderer.domElement;
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  canvas.style.display = 'block';
  mount.appendChild(canvas);

  const scene = new THREE.Scene();
  // The environment IS the lighting. No directional or ambient light is added:
  // every highlight on the coin is a reflection of studio-env.hdr, which is what
  // makes this render and the native ones the same object under the same lamps.
  scene.environment = environment;

  // Framed so the coin fills the box without its corners clipping as it turns.
  const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 10);
  camera.position.set(0, 0, CAMERA_DISTANCE);
  camera.lookAt(0, 0, 0);

  // The element owns the size. A zero-sized box (display:none, or an observer
  // that fires before layout) is skipped — WebGL rejects a zero-wide drawing
  // buffer.
  function resize(): void {
    const width = Math.round(mount.clientWidth);
    const height = Math.round(mount.clientHeight);
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    frameShortSide(camera, width, height);
    draw();
  }

  // The model is spun through a PIVOT rather than directly. The exported node
  // carries its own rotation (the coin is authored lying down and stood up on
  // export), so the node's local Y is the coin's THICKNESS, not its spindle —
  // turning the node itself would tumble the coin end over end.
  const pivot = new THREE.Group();
  pivot.add(model);
  pivot.rotation.x = TILT_X;
  scene.add(pivot);

  const disposeModel = (): void => disposeLoadedModel(model);

  let spin = BASE_SPIN;
  let spinning = false;
  let dragging = false;
  /// Radians of turn the coin owes its clicks. Each click adds `TAP_TURN`;
  /// every frame pays some of it back, so nothing is ever dropped.
  let tapDebt = 0;
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

  /// Pays down what the clicks are owed and answers how much turn that buys
  /// this frame. The debt only ever leaves through here, which is what makes
  /// "no click is dropped" a property of the code rather than a hope.
  function payTapDebt(seconds: number): number {
    const paid = tapTurnPayout(tapDebt, seconds);
    if (paid === 0) return 0;
    tapDebt -= paid;
    // The coin may now have nothing left to do; `step` has already asked for
    // the next frame, so this is what stops it.
    if (tapDebt === 0) sync();
    return paid;
  }

  function step(now: number): void {
    if (disposed) return;
    frame = requestAnimationFrame(step);
    const elapsed = last === 0 ? 0 : Math.min((now - last) / 1000, MAX_FRAME_SECONDS);
    last = now;

    // While a finger is down the pointer owns the angle outright: the coin
    // tracks the hand exactly rather than being nudged by a velocity, which is
    // what makes it feel like an object and not a dial.
    if (dragging) {
      // nothing to integrate: the hand is driving.
    } else {
      const rest = restSpin();
      // Eases in from either side, so a backwards flick settles as gracefully
      // as a celebration spins down.
      spin = rest + (spin - rest) * Math.exp(-SPIN_DECAY * elapsed);
      // The clicks' turn is ADDED to the ambient one rather than replacing it,
      // which is what lets a queue exist at all: there is no single turn with a
      // start to reset, only an angle still owed.
      pivot.rotation.y += spin * elapsed + payTapDebt(elapsed);
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
    if (spinning || dragging || tapDebt > 0 || Math.abs(spin - restSpin()) > 0.01) start();
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
      pivot.rotation.y += radians;
      draw();
    },
    // `thrown` is null when the pointer was resting as it lifted: the coin was
    // placed, and eases back to its resting speed from wherever it was put.
    release: (thrown) => {
      dragging = false;
      spin = thrown === null ? restSpin() : thrown;
      sync();
    },
    // A click adds a turn to what the coin owes. An impatient second click is a
    // second turn, and the tenth is the tenth.
    tap: () => {
      tapDebt += TAP_TURN;
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
      disposeModel();
      environmentTarget.dispose();
      renderer.dispose();
      // WebGL contexts are a small, fixed pool per document; dropping the
      // canvas alone does not give one back.
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
}

/// Points the camera so the coin always fills the SHORTER side of its box: a
/// box that is not square keeps the coin round and centred rather than
/// stretching it.
///
/// `fov` is the VERTICAL angle, so a wide box needs no change and a tall one has
/// to widen vertically until the horizontal angle is back to `BASE_FOV`.
function frameShortSide(
  camera: import('three').PerspectiveCamera,
  width: number,
  height: number,
): void {
  const aspect = width / height;
  camera.aspect = aspect;
  camera.fov =
    aspect >= 1
      ? BASE_FOV
      : (2 * Math.atan(Math.tan((BASE_FOV * Math.PI) / 360) / aspect) * 180) / Math.PI;
  camera.updateProjectionMatrix();
}

/// What a drag does to the thing being turned.
interface TurnTarget {
  grab(): void;
  turnBy(radians: number): void;
  /// Angular velocity in rad/s for a flick, or `null` when the coin was placed
  /// rather than thrown.
  release(thrown: number | null): void;
  /// The pointer went down and came back up without really moving: a click.
  /// Always preceded by `grab()` and `release(null)`, since a click is a drag
  /// that went nowhere.
  tap(): void;
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
  /// Distance travelled and when the press began — together they separate a
  /// click from a drag that happened to end where it started.
  let travelled = 0;
  let pressedAt = 0;
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
    pressedAt = event.timeStamp;
    travelled = 0;
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
    travelled += Math.abs(dx);
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
    // After `release`, so the turn starts from a coin that is already back
    // under its own control.
    if (travelled <= TAP_MAX_MOVEMENT_PX && event.timeStamp - pressedAt <= TAP_MAX_MILLISECONDS) {
      target.tap();
    }
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

/// Frees everything a loaded glTF allocated on the GPU.
///
/// three.js tracks none of it for you: dropping the scene graph leaves the
/// buffers and textures resident, and a Settings sheet that is opened and closed
/// all day would leak a coin per visit.
function disposeLoadedModel(root: import('three').Object3D): void {
  root.traverse((node) => {
    const mesh = node as import('three').Mesh;
    if (mesh.geometry === undefined) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material?.dispose();
    }
  });
}
