// Builds the engine from configuration: the only place that picks its storage and language model.
import { ComfyPainter, type Painter } from "../art/comfy.js";
import { Cutouts, ModelCutter, type Cutter } from "../art/cutout.js";
import { Illustrator } from "../art/illustrator.js";
import { DEFAULT_ART_DIR, type Config } from "../config.js";
import type { Activity } from "../domain/types.js";
import { CampaignLibrary } from "../game/campaigns.js";
import { MockProvider } from "../llm/mock.js";
import { OllamaProvider } from "../llm/ollama.js";
import type { LlmProvider } from "../llm/provider.js";
import { InMemoryStore } from "../storage/memory.js";
import { SqliteStore } from "../storage/sqlite.js";
import type { CampaignStore } from "../storage/store.js";
import { LocalGame } from "./local.js";

export type EngineConfig = Pick<Config, "contentDir" | "storage" | "sqliteFile" | "llm" | "ollamaUrl" | "ollamaModel"> &
  Partial<Pick<Config, "comfyUrl" | "comfyModel" | "artDir" | "npcAgents" | "cutoutModel">>;

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
  /** What cuts portraits out of their backgrounds, instead of the configured model (tests). */
  cutter?: Cutter;
  /**
   * The frontend shows the game's minds at work (behind the scenes): views carry every NPC and who's had to do
   * with whom, and "activity" events tell of each model call and what passes between them.
   */
  minds?: boolean;
}

/** The engine in this process. The model loads in the background; errors surface on the first turn. */
export async function createGame(config: EngineConfig, { pictures = false, painter, cutter, minds = false }: EngineOptions = {}): Promise<LocalGame> {
  const store = createStore(config);
  const llm = createProvider(config);
  void llm.warmUp?.().catch(() => {});
  // NPCs decide for themselves with a real model; the mock one has nothing to say, so they keep their routines.
  const npcAgents = (config.npcAgents ?? "on") === "on" && config.llm !== "mock";
  // What the minds are up to goes to the frontend as events (`game` is there by the time anything happens).
  const library = await CampaignLibrary.load(config.contentDir, store, llm, {
    npcAgents,
    ...(minds && { onActivity: (activity: Activity) => game.emit({ kind: "activity", activity }) }),
  });
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
  // Portraits are cut out of their backgrounds, to show someone large over wherever they are now.
  // (Only with a model configured: loadConfig() always names one, unless it's "off".)
  const model = config.cutoutModel;
  cutter ??= model && model !== "off" ? new ModelCutter(model) : undefined;
  const cutouts =
    pictures && cutter
      ? new Cutouts({
          cutter,
          dir: config.artDir ?? DEFAULT_ART_DIR,
          onReady: (campaignId, npcId) => game.cutoutReady(campaignId, npcId),
          onError: (err) => game.emit({ kind: "notice", text: `Portraits won't be cut out: ${err.message}` }),
        })
      : undefined;
  const game = new LocalGame(library, { illustrator, cutouts, minds, onClose: () => store.close() });
  return game;
}
