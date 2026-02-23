// Web Worker for query embedding using @xenova/transformers
// Load all-MiniLM-L6-v2 int8 ONNX (~23MB)
//
// This file runs in a Worker context.
// eslint-disable-next-line no-restricted-globals

const workerSelf = self as unknown as {
  postMessage(message: any, options?: StructuredSerializeOptions): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

let pipeline: any = null;

async function init(): Promise<void> {
  // @ts-ignore — @xenova/transformers has no type declarations
  const { pipeline: createPipeline } = await import('@xenova/transformers');
  pipeline = await createPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true,
  });
  workerSelf.postMessage({ type: 'ready' });
}

async function embed(text: string): Promise<void> {
  if (!pipeline) throw new Error('Pipeline not initialized');
  const output = await pipeline(text, { pooling: 'mean', normalize: true });
  const embedding = output.data as Float32Array;
  workerSelf.postMessage({ type: 'embedding', data: embedding }, { transfer: [embedding.buffer] });
}

workerSelf.onmessage = async (event: MessageEvent) => {
  const { type, text } = event.data;
  try {
    if (type === 'init') {
      await init();
    } else if (type === 'embed') {
      await embed(text);
    }
  } catch (err) {
    workerSelf.postMessage({ type: 'error', error: String(err) });
  }
};
