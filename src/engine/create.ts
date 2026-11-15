// Builds the engine from configuration: the only place that picks its storage and language model.
import type { Config } from "../config.js";
import { CampaignLibrary } from "../game/campaigns.js";
import { MockProvider } from "../llm/mock.js";
import { OllamaProvider } from "../llm/ollama.js";
import type { LlmProvider } from "../llm/provider.js";
import { InMemoryStore } from "../storage/memory.js";
import { SqliteStore } from "../storage/sqlite.js";
import type { CampaignStore } from "../storage/store.js";
import { LocalGame } from "./local.js";

export type EngineConfig = Pick<Config, "contentDir" | "storage" | "sqliteFile" | "llm" | "ollamaUrl" | "ollamaModel">;

function createProvider(config: EngineConfig): LlmProvider {
  return config.llm === "mock"
    ? new MockProvider()
    : new OllamaProvider({ baseUrl: config.ollamaUrl, model: config.ollamaModel });
}

function createStore(config: EngineConfig): CampaignStore {
  return config.storage === "memory" ? new InMemoryStore() : new SqliteStore(config.sqliteFile);
}

/** The engine in this process. The model loads in the background; errors surface on the first turn. */
export async function createGame(config: EngineConfig): Promise<LocalGame> {
  const store = createStore(config);
  const llm = createProvider(config);
  void llm.warmUp?.().catch(() => {});
  const library = await CampaignLibrary.load(config.contentDir, store, llm);
  return new LocalGame(library, () => store.close());
}
