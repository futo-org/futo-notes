declare module 'node-llama-cpp' {
  interface Llama {
    loadModel(options: { modelPath: string }): Promise<LlamaModel>;
  }

  interface LlamaModel {
    createEmbeddingContext(): Promise<EmbeddingContext>;
    dispose(): Promise<void>;
  }

  interface EmbeddingContext {
    getEmbeddingFor(text: string): Promise<{ vector: Float64Array }>;
    dispose(): Promise<void>;
  }

  export function getLlama(): Promise<Llama>;
}
