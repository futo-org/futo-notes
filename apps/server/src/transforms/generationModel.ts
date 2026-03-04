import type { GenerateFn, GenerateOptions } from './types.js';
import { resolveModelFile, unloadModel as unloadEmbeddingModel, type LoadModelCallbacks } from '../search/modelManager.js';
import { log } from '../logger.js';

interface LoadedState {
  model: { dispose(): Promise<void> };
  context: { getSequence(): unknown; dispose(): Promise<void> };
  LlamaChatSession: new (opts: { contextSequence: unknown; systemPrompt?: string }) => {
    prompt(text: string, opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<string>;
  };
}

const GENERATION_MODEL = {
  id: 'qwen3.5-4b',
  hfUri: 'hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf',
  sizeBytes: 2_800_000_000,
};

let currentModel: LoadedState | null = null;
let loadingPromise: Promise<void> | null = null;

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)}GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)}MB`;
  return `${bytes}B`;
}

export async function loadGenerationModel(
  modelsDir: string,
  callbacks?: LoadModelCallbacks,
): Promise<void> {
  if (currentModel) return;
  if (loadingPromise) {
    await loadingPromise;
    return;
  }

  loadingPromise = (async () => {
    // Free VRAM: unload the search embedding model before loading the generation model.
    // The scheduler lock guarantees no search job is running concurrently.
    await unloadEmbeddingModel();

    log.info(`transforms: downloading/loading generation model "${GENERATION_MODEL.id}" (${formatSize(GENERATION_MODEL.sizeBytes)})...`);

    const modelPath = await resolveModelFile(GENERATION_MODEL.hfUri, modelsDir, callbacks?.onDownloadProgress);
    callbacks?.onDownloadComplete?.();

    log.info(`transforms: loading generation model "${GENERATION_MODEL.id}" into memory...`);

    const llamaCpp = await import('node-llama-cpp');
    const { getLlama, LlamaChatSession } = llamaCpp;
    const llama = await getLlama();

    // Try GPU first, fall back to CPU if VRAM is insufficient
    let model;
    let context;
    try {
      model = await llama.loadModel({ modelPath });
      context = await model.createContext({ contextSize: 8192 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/memory|alloc|context/i.test(msg)) {
        log.warn(`transforms: GPU context failed (${msg}), retrying with gpuLayers=0 (CPU-only)...`);
        if (model) await model.dispose().catch(() => {});
        model = await llama.loadModel({ modelPath, gpuLayers: 0 });
        context = await model.createContext({ contextSize: 8192 });
      } else {
        throw err;
      }
    }

    currentModel = {
      model: model as unknown as LoadedState['model'],
      context: context as unknown as LoadedState['context'],
      LlamaChatSession: LlamaChatSession as unknown as LoadedState['LlamaChatSession'],
    };

    log.info(`transforms: generation model "${GENERATION_MODEL.id}" loaded`);
  })();

  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

export function getGenerateFn(): GenerateFn | null {
  if (!currentModel) return null;

  const { context, LlamaChatSession } = currentModel;

  return async (prompt: string, opts: GenerateOptions): Promise<string> => {
    // Create a fresh session per prompt to avoid context accumulation
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: opts.systemPrompt,
    });

    // Qwen3.5: prefix with /no_think to skip reasoning when thinking=false
    const thinkPrefix = opts.thinking === false ? '/no_think\n' : opts.thinking === true ? '/think\n' : '';
    const fullPrompt = thinkPrefix + prompt;

    const result = await session.prompt(fullPrompt, {
      maxTokens: opts.maxTokens ?? 64,
      temperature: opts.temperature ?? 0.3,
      signal: opts.signal,
    });

    log.info(`transforms: raw output (${result.length} chars): "${result.slice(0, 200)}"`);

    // Strip <think>...</think> blocks that Qwen3.5 may emit
    const cleaned = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return cleaned;
  };
}

export async function unloadGenerationModel(): Promise<void> {
  if (loadingPromise) {
    try {
      await loadingPromise;
    } catch {
      // Ignore load failures; nothing to unload.
    }
  }

  if (!currentModel) return;
  try {
    await currentModel.context.dispose();
    await currentModel.model.dispose();
  } catch (err) {
    log.warn(`transforms: error unloading generation model: ${err instanceof Error ? err.message : String(err)}`);
  }
  currentModel = null;
  log.info('transforms: generation model unloaded');
}

export function isGenerationModelLoaded(): boolean {
  return currentModel !== null;
}

export function getGenerationModelInfo(): { id: string; loaded: boolean } {
  return { id: GENERATION_MODEL.id, loaded: currentModel !== null };
}
