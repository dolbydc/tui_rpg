import type { CompletionRequest, LlmProvider } from "./provider.js";

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
}

/** Chat completions from a local Ollama server (https://github.com/ollama/ollama/blob/main/docs/api.md). */
export class OllamaProvider implements LlmProvider {
  readonly name: string;
  private readonly options: OllamaOptions;

  constructor(options: OllamaOptions) {
    this.options = options;
    this.name = `ollama:${options.model}`;
  }

  async complete({ messages, json, temperature, signal }: CompletionRequest): Promise<string> {
    const body = await this.post<{ message?: { content?: string } }>(
      "/api/chat",
      {
        messages,
        stream: false,
        // Thinking models (gemma4, qwen3) are much slower with reasoning on; turns don't need it.
        think: false,
        // Ollama takes "json" for any object, or a JSON schema for structured output.
        format: json === true ? "json" : json || undefined,
        options: temperature === undefined ? undefined : { temperature },
      },
      signal,
    );
    return body.message?.content ?? "";
  }

  /** A request with no prompt just loads the model; a cold load of a large model can take minutes. */
  async warmUp(): Promise<void> {
    await this.post("/api/generate", {});
  }

  private async post<T>(endpoint: string, payload: object, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 300_000);
    const response = await fetch(`${this.options.baseUrl}${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Keep the model in memory between turns instead of Ollama's default 5 minutes.
      body: JSON.stringify({ model: this.options.model, keep_alive: "30m", ...payload }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      throw new Error(`Ollama ${response.status}: ${await response.text()}`);
    }
    return (await response.json()) as T;
  }
}
