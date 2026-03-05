/**
 * Hanzo Cloud Chat API client — lightweight SSE streaming.
 *
 * Calls the same OpenAI-compatible endpoints that hanzo/chat uses,
 * without React/Recoil overhead.
 */

const API_BASE = 'https://api.hanzo.ai';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt: string; completion: string };
}

export interface ChatCompletionOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

export interface ChatDelta {
  content?: string;
  role?: string;
}

// ---------------------------------------------------------------------------
// API Functions
// ---------------------------------------------------------------------------

/**
 * List available models from Hanzo Cloud.
 */
export async function listModels(token: string): Promise<ChatModel[]> {
  const response = await fetch(`${API_BASE}/v1/models`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to list models: ${response.status}`);
  }

  const data = await response.json();
  return data.data || data.models || data || [];
}

/**
 * Stream a chat completion via SSE.
 *
 * Returns an AbortController so the caller can cancel.
 */
export function chatCompletionStream(
  token: string,
  options: ChatCompletionOptions,
  onChunk: (delta: ChatDelta) => void,
  onDone: () => void,
  onError: (error: Error) => void,
): AbortController {
  const controller = new AbortController();

  (async () => {
    try {
      const response = await fetch(`${API_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ...options,
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Chat API error ${response.status}: ${text}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue; // Skip empty/comment lines

          if (trimmed.startsWith('data: ')) {
            const data = trimmed.slice(6);

            if (data === '[DONE]') {
              onDone();
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (delta) {
                onChunk(delta);
              }
            } catch {
              // Skip malformed JSON chunks
            }
          }
        }
      }

      // Stream ended without [DONE]
      onDone();
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') return;
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return controller;
}

/**
 * Non-streaming chat completion (for simple queries).
 */
export async function chatCompletion(
  token: string,
  options: ChatCompletionOptions,
): Promise<string> {
  const response = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(options),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Chat API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}
