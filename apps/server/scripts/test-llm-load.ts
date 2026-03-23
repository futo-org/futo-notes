import { getLlama, LlamaChatSession } from 'node-llama-cpp';

async function main() {
  const llama = await getLlama();
  console.log('loading model...');
  const model = await llama.loadModel({
    modelPath: '../../data/models/hf_unsloth_Qwen3.5-4B.QWEN3.5-4B-Q4_K_M.GGUF.gguf',
  });
  console.log('model loaded, creating context...');
  const ctx = await model.createContext({ contextSize: 4096 });
  console.log('context created, chatting...');

  const session = new LlamaChatSession({
    contextSequence: ctx.getSequence(),
    systemPrompt: 'You are a helpful assistant. Respond concisely.',
  });

  const result = await session.prompt('What is 2+2? Answer in one word.', {
    maxTokens: 100,
    temperature: 0.1,
  });
  console.log('Result:', JSON.stringify(result));
  console.log('Length:', result.length);

  session.dispose({ disposeSequence: true });
  await ctx.dispose();
  await model.dispose();
}
main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
