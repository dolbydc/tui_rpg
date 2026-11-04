import path from "node:path";
import { PLAYERS, type PlayerName } from "./voice/players.js";

/** Where campaigns live, one folder each. */
export const DEFAULT_CONTENT_DIR = path.resolve(import.meta.dirname, "../content");
/** The Hollow Lantern, which the tests play. */
export const DEFAULT_CAMPAIGN_DIR = path.join(DEFAULT_CONTENT_DIR, "hollow-lantern");
export const DEFAULT_SQLITE_FILE = path.resolve(import.meta.dirname, "../data/tui_rpg.db");

export interface Config {
  /** The folder of campaigns offered at the start menu. */
  contentDir: string;
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
  /** Play each campaign's mood music. */
  music: "on" | "off";
  /** Music volume, 0–1. */
  musicVolume: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    contentDir: env.TUI_RPG_CONTENT_DIR ?? DEFAULT_CONTENT_DIR,
    storage: oneOf(env.TUI_RPG_STORAGE, ["sqlite", "memory"], "TUI_RPG_STORAGE"),
    sqliteFile: env.TUI_RPG_DB ?? DEFAULT_SQLITE_FILE,
    llm: oneOf(env.TUI_RPG_LLM, ["ollama", "mock"], "TUI_RPG_LLM"),
    ollamaUrl: env.OLLAMA_URL ?? "http://localhost:11434",
    ollamaModel: env.OLLAMA_MODEL ?? "gemma4:12b",
    voice: oneOf(env.TUI_RPG_VOICE, ["on", "off"], "TUI_RPG_VOICE"),
    player: env.TUI_RPG_PLAYER === undefined ? undefined : oneOf(env.TUI_RPG_PLAYER, PLAYERS, "TUI_RPG_PLAYER"),
    music: oneOf(env.TUI_RPG_MUSIC, ["on", "off"], "TUI_RPG_MUSIC"),
    musicVolume: volume(env.TUI_RPG_MUSIC_VOLUME),
  };
}

function volume(value: string | undefined): number {
  if (value === undefined) return 0.4;
  const n = Number(value);
  if (!(n >= 0 && n <= 1)) throw new Error(`TUI_RPG_MUSIC_VOLUME must be from 0 to 1 (got "${value}")`);
  return n;
}

/** The first option is the default. */
function oneOf<T extends string>(value: string | undefined, options: readonly [T, ...T[]], name: string): T {
  if (value === undefined) return options[0];
  if (!(options as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${options.join(", ")} (got "${value}")`);
  }
  return value as T;
}
