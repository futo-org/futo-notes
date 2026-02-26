import type { ModelDef } from './modelRegistry.js';
import { log } from '../logger.js';

// Types for node-llama-cpp (dynamically imported)
interface LlamaModel {
  dispose(): Promise<void>;
}

interface LlamaContext {
  dispose(): Promise<void>;
  getEmbeddingFor(text: string): Promise<{ vector: Float64Array }>;
}

export interface EmbeddingModel {
  model: LlamaModel;
  context: LlamaContext;
  dims: number;
  queryPrefix: string | null;
  docPrefix: string | null;
  embedDocuments: (texts: string[]) => Promise<number[][]>;
  embedQuery: (query: string) => Promise<number[]>;
}

let currentModel: EmbeddingModel | null = null;
let loadingModelPromise: Promise<EmbeddingModel> | null = null;
const CONTEXT_SIZE_ERR_RE = /longer than the context size/i;

function isContextSizeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return CONTEXT_SIZE_ERR_RE.test(message);
}

async function getEmbeddingWithRetry(
  context: LlamaContext,
  text: string,
  prefix: string | null,
): Promise<Float64Array> {
  let body = text;
  const minChars = 256;

  for (let attempt = 0; attempt < 8; attempt++) {
    const input = prefix ? prefix + body : body;
    try {
      const embedding = await context.getEmbeddingFor(input);
      return embedding.vector;
    } catch (err) {
      if (!isContextSizeError(err) || body.length <= minChars) {
        throw err;
      }

      const nextLen = Math.max(minChars, Math.floor(body.length * 0.75));
      log.warn(`search: embedding input exceeds context (${body.length} chars), retrying with ${nextLen} chars`);
      body = body.slice(0, nextLen);
    }
  }

  throw new Error('Failed to embed input after context-size retries');
}

/**
 * Resolve a model file from an hf: URI or local path.
 * Downloads from HuggingFace if not already cached in modelsDir.
 *
 * Uses node-llama-cpp's resolveModelFile which supports hf: URIs
 * and caches downloads in the specified directory.
 */
export async function resolveModelFile(
  hfUri: string,
  modelsDir: string,
  onProgress?: (status: { totalSize: number; downloadedSize: number }) => void,
): Promise<string> {
  // resolveModelFile exists at runtime but isn't in all type definitions
  const llamaCpp: Record<string, unknown> = await import('node-llama-cpp');
  const resolve = llamaCpp['resolveModelFile'] as
    (uri: string, opts: { directory: string; cli: boolean; onProgress?: (status: { totalSize: number; downloadedSize: number }) => void }) => Promise<string>;
  return resolve(hfUri, { directory: modelsDir, cli: false, onProgress });
}

export interface LoadModelCallbacks {
  onDownloadProgress?: (status: { totalSize: number; downloadedSize: number }) => void;
  onDownloadComplete?: () => void;
}

/**
 * Load an embedding model from a ModelDef.
 * Downloads the GGUF file if necessary, then loads via node-llama-cpp.
 */
export async function loadEmbeddingModel(
  modelDef: ModelDef,
  modelsDir: string,
  callbacks?: LoadModelCallbacks,
): Promise<EmbeddingModel> {
  if (currentModel) {
    return currentModel;
  }
  if (loadingModelPromise) {
    return loadingModelPromise;
  }

  loadingModelPromise = (async () => {
    log.info(`search: downloading/loading model "${modelDef.id}" (${formatSize(modelDef.sizeBytes)})...`);

    const modelPath = await resolveModelFile(modelDef.hfUri, modelsDir, callbacks?.onDownloadProgress);
    callbacks?.onDownloadComplete?.();

    log.info(`search: loading model "${modelDef.id}" into memory...`);

    const llamaCpp = await import('node-llama-cpp');
    const { getLlama } = llamaCpp;
    const llama = await getLlama();

    const model = await llama.loadModel({ modelPath });
    const context = await model.createEmbeddingContext();

    const { dims, queryPrefix, docPrefix } = modelDef;

    function truncate(vector: number[]): number[] {
      return vector.length > dims ? vector.slice(0, dims) : vector;
    }

    const embedDocuments = async (texts: string[]): Promise<number[][]> => {
      const results: number[][] = [];
      for (const text of texts) {
        const vector = await getEmbeddingWithRetry(context as LlamaContext, text, docPrefix);
        results.push(truncate(Array.from(vector)));
      }
      return results;
    };

    const embedQuery = async (query: string): Promise<number[]> => {
      const vector = await getEmbeddingWithRetry(context as LlamaContext, query, queryPrefix);
      return truncate(Array.from(vector));
    };

    currentModel = {
      model: model as unknown as LlamaModel,
      context: context as unknown as LlamaContext,
      dims,
      queryPrefix,
      docPrefix,
      embedDocuments,
      embedQuery,
    };

    log.info(`search: model "${modelDef.id}" loaded (dims=${dims})`);
    return currentModel;
  })();

  try {
    return await loadingModelPromise;
  } finally {
    loadingModelPromise = null;
  }
}

/**
 * Get the currently loaded embedding model, or null if none is loaded.
 */
export function getActiveModel(): EmbeddingModel | null {
  return currentModel;
}

/**
 * Unload the current model and free resources.
 */
export async function unloadModel(): Promise<void> {
  if (loadingModelPromise) {
    try {
      await loadingModelPromise;
    } catch {
      // Ignore load failures; nothing to unload.
    }
  }

  if (!currentModel) return;
  try {
    await currentModel.context.dispose();
    await currentModel.model.dispose();
  } catch (err) {
    log.warn(`search: error unloading model: ${err instanceof Error ? err.message : String(err)}`);
  }
  currentModel = null;
  log.info('search: model unloaded');
}

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)}GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)}MB`;
  return `${bytes}B`;
}
