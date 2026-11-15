// Builds the engine from configuration: the only place that picks its storage and language model.
import { ComfyPainter, type Painter } from "../art/comfy.js";
import { Illustrator } from "../art/illustrator.js";
import { DEFAULT_ART_DIR, type Config } from "../config.js";
import { CampaignLibrary } from "../game/campaigns.js";
import { MockProvider } from "../llm/mock.js";
import { OllamaProvider } from "../llm/ollama.js";
import type { LlmProvider } from "../llm/provider.js";
import { InMemoryStore } from "../storage/memory.js";
import { SqliteStore } from "../storage/sqlite.js";
import type { CampaignStore } from "../storage/store.js";
import { LocalGame } from "./local.js";

export type EngineConfig = Pick<Config, "contentDir" | "storage" | "sqliteFile" | "llm" | "ollamaUrl" | "ollamaModel"> &
  Partial<Pick<Config, "comfyUrl" | "comfyModel" | "artDir">>;

function createProvider(config: EngineConfig): LlmProvider {
  return config.llm === "mock"
    ? new MockProvider()
    : new OllamaProvider({ baseUrl: config.ollamaUrl, model: config.ollamaModel });
}

function createStore(config: EngineConfig): CampaignStore {
  return config.storage === "memory" ? new InMemoryStore() : new SqliteStore(config.sqliteFile);
}

export interface EngineOptions {
  /**
   * The frontend shows pictures of places: those without one of their own are drawn, when there's a ComfyUI
   * to draw them (`comfyUrl`). A frontend that doesn't show them leaves this off, and nothing is drawn.
   */
  pictures?: boolean;
  /** What draws them, instead of the configured ComfyUI (tests). */
  painter?: Painter;
}

/** The engine in this process. The model loads in the background; errors surface on the first turn. */
export async function createGame(config: EngineConfig, { pictures = false, painter }: EngineOptions = {}): Promise<LocalGame> {
  const store = createStore(config);
  const llm = createProvider(config);
  void llm.warmUp?.().catch(() => {});
  const library = await CampaignLibrary.load(config.contentDir, store, llm);
  painter ??= config.comfyUrl ? new ComfyPainter({ url: config.comfyUrl, model: config.comfyModel }) : undefined;
  const illustrator =
    pictures && painter
      ? new Illustrator({
          painter,
          llm,
          dir: config.artDir ?? DEFAULT_ART_DIR,
          onReady: (campaignId, subject) => game.pictureReady(campaignId, subject),
          onError: (err) => game.picturesFailed(err),
        })
      : undefined;
  const game = new LocalGame(library, { illustrator, onClose: () => store.close() });
  return game;
}
