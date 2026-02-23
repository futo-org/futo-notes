import { log } from '../logger.js';

// Types for node-llama-cpp (dynamically imported)
interface LlamaModel {
  dispose(): Promise<void>;
}

interface LlamaContext {
  dispose(): Promise<void>;
}

export interface EmbeddingModel {
  model: LlamaModel;
  context: LlamaContext;
  embed: (texts: string[]) => Promise<number[][]>;
}

let currentModel: EmbeddingModel | null = null;

/**
 * Load an embedding model via node-llama-cpp.
 * Uses dynamic import so the dependency is only loaded when SEARCH_ENABLED=true.
 */
export async function loadEmbeddingModel(modelName: string): Promise<EmbeddingModel> {
  if (currentModel) {
    return currentModel;
  }

  log.info(`search: loading embedding model "${modelName}"...`);

  // Dynamic import
  const llamaCpp = await import('node-llama-cpp');
  const { getLlama } = llamaCpp;

  const llama = await getLlama();

  // node-llama-cpp resolves model names to local GGUF files
  // In practice, the user would configure a model path or the library
  // would manage downloading. For now we use the default model resolution.
  const model = await llama.loadModel({
    modelPath: modelName,
  });

  const context = await model.createEmbeddingContext();

  const embed = async (texts: string[]): Promise<number[][]> => {
    const results: number[][] = [];
    for (const text of texts) {
      const embedding = await context.getEmbeddingFor(text);
      results.push(Array.from(embedding.vector));
    }
    return results;
  };

  currentModel = {
    model: model as unknown as LlamaModel,
    context: context as unknown as LlamaContext,
    embed,
  };

  log.info(`search: model "${modelName}" loaded`);
  return currentModel;
}

/**
 * Batch embed texts using a loaded model.
 */
export async function embedTexts(model: EmbeddingModel, texts: string[]): Promise<number[][]> {
  return model.embed(texts);
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
