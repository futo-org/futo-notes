import { Ollama } from 'ollama';
import { Agent } from 'undici';
import { log } from '../logger.js';
import type { RunBuiltinLlmInput } from './types.js';
import type { LoadModelCallbacks } from '../search/modelManager.js';

// Custom fetch with extended timeouts for long-running LLM inference on CPU
const llmAgent = new Agent({ bodyTimeout: 0, headersTimeout: 0, connectTimeout: 30_000 });
function llmFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, dispatcher: llmAgent } as RequestInit);
}

const BUILTIN_LLM = {
  id: 'qwen3.5:4b',
  ollamaModel: 'qwen3.5:4b',
};

let ollamaClient: Ollama | null = null;
let modelReady = false;
let loadingPromise: Promise<void> | null = null;
let testResponder: ((input: RunBuiltinLlmInput) => Promise<string> | string) | null = null;

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

export async function loadBuiltinLlm(
  _modelsDir: string,
  callbacks?: LoadModelCallbacks,
): Promise<void> {
  if (testResponder) return;
  if (modelReady) return;
  if (loadingPromise) {
    await loadingPromise;
    return;
  }

  loadingPromise = (async () => {
    log.info(`plugins: connecting to Ollama for model "${BUILTIN_LLM.id}"...`);

    const client = new Ollama({ fetch: llmFetch as typeof globalThis.fetch });

    // Verify the model is available
    try {
      const models = await client.list();
      const available = models.models.some((m) => m.name === BUILTIN_LLM.ollamaModel || m.name.startsWith(BUILTIN_LLM.ollamaModel));
      if (!available) {
        log.info(`plugins: pulling model "${BUILTIN_LLM.ollamaModel}" via Ollama...`);
        const stream = await client.pull({ model: BUILTIN_LLM.ollamaModel, stream: true });
        for await (const progress of stream) {
          if (progress.total && progress.completed) {
            callbacks?.onDownloadProgress?.({
              totalSize: progress.total,
              downloadedSize: progress.completed,
            });
          }
        }
        callbacks?.onDownloadComplete?.();
      }
    } catch (err) {
      throw new Error(`Failed to connect to Ollama: ${err instanceof Error ? err.message : String(err)}. Is Ollama running?`);
    }

    ollamaClient = client;
    modelReady = true;
    log.info(`plugins: Ollama model "${BUILTIN_LLM.id}" ready`);
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
  if (!ollamaClient || !modelReady) return null;

  const client = ollamaClient;

  return async (input: RunBuiltinLlmInput): Promise<string> => {
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
    if (input.systemPrompt) {
      messages.push({ role: 'system', content: input.systemPrompt });
    }
    messages.push({ role: 'user', content: input.userPrompt });

    const response = await withTimeout(client.chat({
      model: BUILTIN_LLM.ollamaModel,
      messages,
      think: !input.disableThinking,
      options: {
        num_predict: input.maxTokens ?? 64,
        temperature: input.temperature ?? 0.3,
      },
    }), input.timeoutMs);

    const result = response.message.content;
    log.info(`plugins: raw LLM output (${result.length} chars) for purpose="${input.purpose}": "${result.slice(0, 200)}"`);
    const stripped = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (stripped.length === 0 && result.length > 0) {
      log.warn(`plugins: LLM output was entirely think tags (${result.length} chars of thinking, 0 chars of answer)`);
    }
    return stripped;
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

  ollamaClient = null;
  modelReady = false;
  log.info('plugins: Ollama LLM connection released');
}

export function isBuiltinLlmLoaded(): boolean {
  return testResponder !== null || modelReady;
}

export function getBuiltinLlmInfo(): { id: string; loaded: boolean } {
  return { id: testResponder ? 'test-double' : BUILTIN_LLM.id, loaded: testResponder !== null || modelReady };
}

export function __setTestLlmResponder(responder: ((input: RunBuiltinLlmInput) => Promise<string> | string) | null): void {
  testResponder = responder;
}
