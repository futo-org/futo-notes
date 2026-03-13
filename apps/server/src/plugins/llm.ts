import { resolveModelFile, unloadModel as unloadEmbeddingModel, type LoadModelCallbacks } from '../search/modelManager.js';
import { log } from '../logger.js';
import type { RunBuiltinLlmInput } from './types.js';

interface LoadedState {
  model: { dispose(): Promise<void> };
  context: { getSequence(): unknown; dispose(): Promise<void> };
  LlamaChatSession: new (opts: { contextSequence: unknown; systemPrompt?: string; autoDisposeSequence?: boolean }) => {
    prompt(text: string, opts?: { maxTokens?: number; temperature?: number; signal?: AbortSignal }): Promise<string>;
    dispose(opts?: { disposeSequence?: boolean }): void;
  };
}

const BUILTIN_LLM = {
  id: 'qwen3.5-4b',
  hfUri: 'hf:Qwen/Qwen3-4B-GGUF:Qwen3-4B-Q4_K_M.gguf',
  sizeBytes: 2_800_000_000,
};

let currentModel: LoadedState | null = null;
let loadingPromise: Promise<void> | null = null;
let testResponder: ((input: RunBuiltinLlmInput) => Promise<string> | string) | null = null;

function formatSize(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)}GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)}MB`;
  return `${bytes}B`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LLM request timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function preparePromptForModel(input: RunBuiltinLlmInput): { systemPrompt?: string; userPrompt: string } {
  let userPrompt = input.userPrompt;

  // Qwen3 supports /no_think as a soft switch for direct answers.
  if (input.disableThinking && !userPrompt.startsWith('/no_think')) {
    userPrompt = `/no_think\n${userPrompt}`;
  }

  return {
    systemPrompt: input.systemPrompt,
    userPrompt,
  };
}

export async function loadBuiltinLlm(
  modelsDir: string,
  callbacks?: LoadModelCallbacks,
): Promise<void> {
  if (testResponder) return;
  if (currentModel) return;
  if (loadingPromise) {
    await loadingPromise;
    return;
  }

  loadingPromise = (async () => {
    await unloadEmbeddingModel();

    log.info(`plugins: downloading/loading built-in LLM "${BUILTIN_LLM.id}" (${formatSize(BUILTIN_LLM.sizeBytes)})...`);

    const modelPath = await resolveModelFile(BUILTIN_LLM.hfUri, modelsDir, callbacks?.onDownloadProgress);
    callbacks?.onDownloadComplete?.();

    log.info(`plugins: loading built-in LLM "${BUILTIN_LLM.id}" into memory...`);

    const llamaCpp = await import('node-llama-cpp');
    const { getLlama, LlamaChatSession } = llamaCpp;
    const llama = await getLlama();

    let model;
    let context;
    try {
      model = await llama.loadModel({ modelPath });
      context = await model.createContext({ contextSize: 8192 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/memory|alloc|context/i.test(msg)) {
        log.warn(`plugins: GPU context failed (${msg}), retrying with gpuLayers=0 (CPU-only)...`);
        if (model) await model.dispose().catch(() => {});
        model = await llama.loadModel({ modelPath, gpuLayers: 0 });
        context = await model.createContext({ contextSize: 8192 });
      } else {
        throw err;
      }
    }

    currentModel = {
      model: model as LoadedState['model'],
      context: context as LoadedState['context'],
      LlamaChatSession: LlamaChatSession as LoadedState['LlamaChatSession'],
    };

    log.info(`plugins: built-in LLM "${BUILTIN_LLM.id}" loaded`);
  })();

  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

export function getBuiltinLlmRunner(): ((input: RunBuiltinLlmInput) => Promise<string>) | null {
  if (testResponder) {
    const responder = testResponder;
    return async (input) => Promise.resolve(responder(input));
  }
  if (!currentModel) return null;

  const { context, LlamaChatSession } = currentModel;

  return async (input: RunBuiltinLlmInput): Promise<string> => {
    const prompt = preparePromptForModel(input);
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: prompt.systemPrompt,
      autoDisposeSequence: true,
    });

    try {
      const result = await withTimeout(session.prompt(prompt.userPrompt, {
        maxTokens: input.maxTokens ?? 64,
        temperature: input.temperature ?? 0.3,
      }), input.timeoutMs);

      log.info(`plugins: raw LLM output (${result.length} chars) for purpose="${input.purpose}": "${result.slice(0, 200)}"`);
      return result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } finally {
      session.dispose({ disposeSequence: true });
    }
  };
}

export async function unloadBuiltinLlm(): Promise<void> {
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
    log.warn(`plugins: error unloading built-in LLM: ${err instanceof Error ? err.message : String(err)}`);
  }
  currentModel = null;
  log.info('plugins: built-in LLM unloaded');
}

export function isBuiltinLlmLoaded(): boolean {
  return testResponder !== null || currentModel !== null;
}

export function getBuiltinLlmInfo(): { id: string; loaded: boolean } {
  return { id: testResponder ? 'test-double' : BUILTIN_LLM.id, loaded: testResponder !== null || currentModel !== null };
}

export function __setTestLlmResponder(responder: ((input: RunBuiltinLlmInput) => Promise<string> | string) | null): void {
  testResponder = responder;
}
