export interface SearchMethodCapability {
  supported: boolean;
}

export interface SearchMethodsCapabilities {
  keyword: SearchMethodCapability;
  vector: SearchMethodCapability;
  hybrid: SearchMethodCapability;
}

export interface SearchCapabilities {
  levels: number[];
  model: string | null;
  dims: number | null;
  chunk_count: number;
  last_indexed_at: number | null;
  artifact_version: string | null;
  artifact_hash: string | null;
  query_prefix: string | null;
  methods?: SearchMethodsCapabilities;
}
