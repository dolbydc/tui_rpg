import path from "node:path";
import { PLAYERS, type PlayerName } from "./voice/players.js";

export const DEFAULT_CAMPAIGN_DIR = path.resolve(import.meta.dirname, "../content/hollow-lantern");
export const DEFAULT_SQLITE_FILE = path.resolve(import.meta.dirname, "../data/tui_rpg.db");

export interface Config {
  campaignDir: string;
  campaignId: string;
  storage: "sqlite" | "memory";
  /** The SQLite database file. */
  sqliteFile: string;
  llm: "ollama" | "mock";
  ollamaUrl: string;
  ollamaModel: string;
  /** Read narration and dialogue aloud (local Kokoro text-to-speech). */
  voice: "on" | "off";
  /** What plays the audio, when the one picked for this system isn't wanted. */
  player?: PlayerName;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    campaignDir: env.TUI_RPG_CAMPAIGN_DIR ?? DEFAULT_CAMPAIGN_DIR,
    campaignId: env.TUI_RPG_CAMPAIGN_ID ?? "default",
    storage: oneOf(env.TUI_RPG_STORAGE, ["sqlite", "memory"], "TUI_RPG_STORAGE"),
    sqliteFile: env.TUI_RPG_DB ?? DEFAULT_SQLITE_FILE,
    llm: oneOf(env.TUI_RPG_LLM, ["ollama", "mock"], "TUI_RPG_LLM"),
    ollamaUrl: env.OLLAMA_URL ?? "http://localhost:11434",
    ollamaModel: env.OLLAMA_MODEL ?? "gemma4:12b",
    voice: oneOf(env.TUI_RPG_VOICE, ["on", "off"], "TUI_RPG_VOICE"),
    player: env.TUI_RPG_PLAYER === undefined ? undefined : oneOf(env.TUI_RPG_PLAYER, PLAYERS, "TUI_RPG_PLAYER"),
  };
}

/** The first option is the default. */
function oneOf<T extends string>(value: string | undefined, options: readonly [T, ...T[]], name: string): T {
  if (value === undefined) return options[0];
  if (!(options as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${options.join(", ")} (got "${value}")`);
  }
  return value as T;
}
