/// The Blender exports. `?url` keeps them out of the JS bundle: Vite emits them
/// as hashed files and hands back the path, so the coin costs nothing until a
/// licensed user opens Settings.
import coinModelUrl from '@/assets/coin/futo-coin.glb?url';
import coinEnvironmentUrl from '@/assets/coin/studio-env.hdr?url';

/// Exposure for the Khronos PBR Neutral tone map (see `openStage`).
const TONE_MAPPING_EXPOSURE = 1.0;

/// The renderer plus everything loaded onto it: the model and the prefiltered
/// environment that lights it.
export interface CoinStage {
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
export async function openStage(
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
  // toward white, which on this coin turns the gold sheen into a gray smear
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

/// Frees everything a loaded glTF allocated on the GPU.
///
/// three.js tracks none of it for you: dropping the scene graph leaves the
/// buffers and textures resident, and a Settings sheet that is opened and closed
/// all day would leak a coin per visit.
export function disposeLoadedModel(root: import('three').Object3D): void {
  root.traverse((node) => {
    const mesh = node as import('three').Mesh;
    if (mesh.geometry === undefined) return;
    mesh.geometry.dispose();
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      material?.dispose();
    }
  });
}
