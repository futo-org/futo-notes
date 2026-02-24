export interface ModelDef {
  id: string;
  hfUri: string;
  nativeDims: number;
  dims: number;
  sizeBytes: number;
  queryPrefix: string | null;
  docPrefix: string | null;
}

const QWEN3_QUERY_PREFIX =
  'Instruct: Given a user search query, retrieve the most relevant personal notes\nQuery: ';

export const MODEL_REGISTRY: ModelDef[] = [
  {
    id: 'bge-small-en-v1.5',
    hfUri: 'hf:CompendiumLabs/bge-small-en-v1.5-gguf:bge-small-en-v1.5-q8_0.gguf',
    nativeDims: 384,
    dims: 384,
    sizeBytes: 37_000_000,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    docPrefix: null,
  },
  {
    id: 'qwen3-embedding-0.6b',
    hfUri: 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF:Qwen3-Embedding-0.6B-Q8_0.gguf',
    nativeDims: 1024,
    dims: 1024,
    sizeBytes: 639_000_000,
    queryPrefix: QWEN3_QUERY_PREFIX,
    docPrefix: null,
  },
  {
    id: 'qwen3-embedding-4b',
    hfUri: 'hf:Qwen/Qwen3-Embedding-4B-GGUF:Qwen3-Embedding-4B-Q8_0.gguf',
    nativeDims: 2560,
    dims: 1024,
    sizeBytes: 4_300_000_000,
    queryPrefix: QWEN3_QUERY_PREFIX,
    docPrefix: null,
  },
  {
    id: 'qwen3-embedding-8b',
    hfUri: 'hf:Qwen/Qwen3-Embedding-8B-GGUF:Qwen3-Embedding-8B-Q8_0.gguf',
    nativeDims: 4096,
    dims: 1024,
    sizeBytes: 8_100_000_000,
    queryPrefix: QWEN3_QUERY_PREFIX,
    docPrefix: null,
  },
];

/** Model used for hardware benchmarking (smallest, fast to download). */
export const BENCHMARK_MODEL_ID = 'bge-small-en-v1.5';

export function getModelDef(id: string): ModelDef | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}
