declare module 'node-llama-cpp' {
  interface Llama {
    loadModel(options: { modelPath: string; gpuLayers?: number | 'max' }): Promise<LlamaModel>;
  }

  interface LlamaModel {
    createEmbeddingContext(): Promise<EmbeddingContext>;
    createContext(options?: { contextSize?: number }): Promise<LlamaContext>;
    dispose(): Promise<void>;
  }

  interface EmbeddingContext {
    getEmbeddingFor(text: string): Promise<{ vector: Float64Array }>;
    dispose(): Promise<void>;
  }

  interface LlamaContext {
    getSequence(): LlamaContextSequence;
    dispose(): Promise<void>;
  }

  interface LlamaContextSequence {}

  class LlamaChatSession {
    constructor(options: { contextSequence: LlamaContextSequence; systemPrompt?: string });
    prompt(text: string, options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<string>;
  }

  class LlamaCompletion {
    constructor(options: { contextSequence: LlamaContextSequence });
    generateCompletion(input: string, options?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<string>;
  }

  export function getLlama(): Promise<Llama>;
}
