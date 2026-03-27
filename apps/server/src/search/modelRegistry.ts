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
    id: 'qwen3-embedding-0.6b',
    hfUri: 'hf:enacimie/Qwen3-Embedding-0.6B-Q4_K_M-GGUF/qwen3-embedding-0.6b-q4_k_m.gguf',
    nativeDims: 1024,
    dims: 1024,
    sizeBytes: 396_000_000,
    queryPrefix: QWEN3_QUERY_PREFIX,
    docPrefix: null,
  },
];

/** The single supported embedding model. */
export const DEFAULT_MODEL_ID = 'qwen3-embedding-0.6b';

export function getModelDef(id: string): ModelDef | undefined {
  return MODEL_REGISTRY.find((m) => m.id === id);
}
