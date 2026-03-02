/**
 * LLM backend abstraction — supports Ollama and vLLM.
 */

/**
 * @param {{ backend: 'ollama'|'vllm', host: string, model: string }} opts
 * @returns {(req: { messages: Array, schema?: object, think?: boolean, temperature?: number }) => Promise<string>}
 */
export function createLlmClient({ backend, host, model }) {
  const baseUrl = host.replace(/\/+$/, '');

  if (backend === 'vllm') {
    return async ({ messages, schema, think, temperature = 0.3 }) => {
      const body = {
        model,
        messages,
        temperature,
        max_tokens: 4096,
      };

      if (schema) body.guided_json = schema;
      if (think) body.chat_template_kwargs = { enable_thinking: true };

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`vLLM request failed (${response.status}): ${text.slice(0, 500)}`);
      }

      const payload = await response.json();
      let content = payload.choices?.[0]?.message?.content;
      if (!content) throw new Error('vLLM response missing message content');

      if (think) content = stripThinkTags(content);
      return content;
    };
  }

  // Default: Ollama
  return async ({ messages, schema, think, temperature = 0.3 }) => {
    const body = {
      model,
      stream: false,
      options: { temperature, num_ctx: 8192 },
      messages,
    };

    // When thinking is enabled, don't constrain format so <think> tags can flow.
    if (schema && !think) {
      body.format = schema;
    }

    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama request failed (${response.status}): ${text.slice(0, 500)}`);
    }

    const payload = await response.json();
    if (!payload?.message) throw new Error('Ollama response missing message payload');

    let content = payload.message.content;
    if (think) content = stripThinkTags(content);
    return content;
  };
}

/**
 * Verify the LLM backend is reachable and the model is available.
 */
export async function verifyConnection({ backend, host, model }) {
  const baseUrl = host.replace(/\/+$/, '');

  if (backend === 'vllm') {
    const response = await fetch(`${baseUrl}/v1/models`);
    if (!response.ok) throw new Error(`vLLM /v1/models failed (${response.status})`);
    const payload = await response.json();
    const models = Array.isArray(payload.data) ? payload.data : [];
    const hasModel = models.some(m => m?.id === model);
    if (!hasModel) {
      const available = models.map(m => m?.id).join(', ');
      throw new Error(`Model not found: ${model}. Available: ${available}`);
    }
    return;
  }

  // Default: Ollama
  const response = await fetch(`${baseUrl}/api/tags`);
  if (!response.ok) throw new Error(`Ollama /api/tags failed (${response.status})`);
  const payload = await response.json();
  const models = Array.isArray(payload.models) ? payload.models : [];
  if (!models.some(m => m?.name === model || m?.model === model)) {
    throw new Error(`Model not found: ${model}. Run: ollama pull ${model}`);
  }
}

export function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
