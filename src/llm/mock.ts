import type { CompletionRequest, LlmProvider } from "./provider.js";

export type MockResponder = (request: CompletionRequest) => string;

/** Scripted provider for tests and for running the game without a model. Records every request. */
export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly requests: CompletionRequest[] = [];
  private readonly respond: MockResponder;

  constructor(respond: MockResponder = offlineResponder) {
    this.respond = respond;
  }

  async complete(request: CompletionRequest): Promise<string> {
    this.requests.push(request);
    return this.respond(request);
  }
}

/** Treats all free text as a generic action and narrates it blandly. */
export function offlineResponder(request: CompletionRequest): string {
  if (request.json) {
    const input = request.messages.at(-1)?.content.split("Player input: ").at(-1) ?? "";
    return JSON.stringify({ kind: "act", action: input });
  }
  return "(The mock narrator nods. Nothing much happens.)";
}
