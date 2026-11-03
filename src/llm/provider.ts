export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  /** Constrain the reply to a JSON object, or to one matching this JSON schema. */
  json?: boolean | Record<string, unknown>;
  temperature?: number;
  signal?: AbortSignal;
}

/** The only way the app talks to a language model. Swap implementations without touching callers. */
export interface LlmProvider {
  readonly name: string;
  complete(request: CompletionRequest): Promise<string>;
  /** Optionally load the model ahead of the first turn. */
  warmUp?(): Promise<void>;
}
