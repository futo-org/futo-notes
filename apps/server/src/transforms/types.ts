import type Database from 'better-sqlite3';

export interface TransformConfigField {
  key: string;
  label: string;
  type: 'boolean' | 'number' | 'string';
  default: boolean | number | string;
  description?: string;
  min?: number;
  max?: number;
}

export interface TransformResult {
  noteUuid: string;
  action: string;
  oldFilename?: string;
  newFilename?: string;
}

export interface SmartTransform {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly configSchema: TransformConfigField[];

  /** Return UUIDs needing processing. Must be fast (DB query, no LLM).
   *  When force=true, skip the "recently modified" cooldown (e.g. manual trigger). */
  getPendingNotes(db: Database.Database, opts?: { force?: boolean }): string[];

  /** Execute on a batch. Must respect AbortSignal. */
  execute(
    db: Database.Database,
    notesPath: string,
    uuids: string[],
    config: Record<string, unknown>,
    generate: GenerateFn,
    signal: AbortSignal,
  ): Promise<TransformResult[]>;
}

export type GenerateFn = (prompt: string, opts: GenerateOptions) => Promise<string>;

export interface GenerateOptions {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  thinking?: boolean;
  signal?: AbortSignal;
}
