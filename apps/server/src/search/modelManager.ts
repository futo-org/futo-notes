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
): Promise<string> {
  // resolveModelFile exists at runtime but isn't in all type definitions
  const llamaCpp: Record<string, unknown> = await import('node-llama-cpp');
  const resolve = llamaCpp['resolveModelFile'] as
    (uri: string, dir: string) => Promise<string>;
  return resolve(hfUri, modelsDir);
}

/**
 * Load an embedding model from a ModelDef.
 * Downloads the GGUF file if necessary, then loads via node-llama-cpp.
 */
export async function loadEmbeddingModel(
  modelDef: ModelDef,
  modelsDir: string,
): Promise<EmbeddingModel> {
  if (currentModel) {
    return currentModel;
  }

  log.info(`search: loading model "${modelDef.id}" (${formatSize(modelDef.sizeBytes)})...`);

  const modelPath = await resolveModelFile(modelDef.hfUri, modelsDir);

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
      const input = docPrefix ? docPrefix + text : text;
      const embedding = await context.getEmbeddingFor(input);
      results.push(truncate(Array.from(embedding.vector)));
    }
    return results;
  };

  const embedQuery = async (query: string): Promise<number[]> => {
    const input = queryPrefix ? queryPrefix + query : query;
    const embedding = await context.getEmbeddingFor(input);
    return truncate(Array.from(embedding.vector));
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
