// The engine's contract with its frontends (the terminal UI, Electron, anything else). Everything here is
// plain data that survives JSON, so a frontend can drive an engine in the same process (LocalGame) or in
// another one (RemoteGame, over host.ts). Frontends import from here, not from the engine's internals.
import type { Character, LogLine, MapView, Quest } from "../domain/types.js";
import type { PlayerStatus, TurnResult } from "../game/session.js";
import type { SaveSummary } from "../storage/store.js";

export type { Character, GridPosition, LogLine, MapCell, MapView, Quest, TimeOfDay } from "../domain/types.js";
export type { PlayerStatus, TurnResult } from "../game/session.js";
export type { SaveSummary } from "../storage/store.js";

/** A campaign on offer at the start menu. */
export interface CampaignSummary {
  id: string;
  title: string;
  /** One line for the menu. */
  tagline?: string;
}

export interface Library {
  campaigns: CampaignSummary[];
  /** Most recently played first. */
  saves: SaveSummary[];
}

/** Someone the player can see, as the player knows them. */
export interface PersonView {
  id: string;
  /** Their name once the player has learned it, else their epithet ("the old man"). */
  label: string;
  /** How they look ("a hunched old man in a sodden wool coat"). */
  appearance: string;
  known: boolean;
  /** A picture of them (an absolute file path): the campaign's, or a portrait drawn. */
  image?: string;
  /** A portrait of them is on its way (an event will bring the view with it). */
  drawing?: boolean;
}

/** What the player can see and knows of their game: nothing the world keeps hidden from them. */
export interface PlayerView {
  /** `drawing`: a picture of it is on its way (an event will bring the view with it). */
  place: { id: string; name: string; image?: string; drawing?: boolean };
  /** Who's here with the player. */
  people: PersonView[];
  character: Character;
  /** Quests the player knows of (active or completed); hidden ones aren't listed. */
  quests: Quest[];
  map: MapView;
  status: PlayerStatus;
}

export interface GameView {
  /** The campaign's title. */
  title: string;
  /** Undefined while a character is being made, before there's a game. */
  player?: PlayerView;
  /** The mood music where the player is (an absolute file path); undefined for silence. */
  music?: string;
}

/** Who reads what aloud, for frontends that speak: the narrator's voice, and each NPC's. */
export interface Cast {
  narratorVoice?: string;
  npcs: Record<string, { voice?: string; pronouns: string }>;
  /** Place names, so a scene's heading isn't read out. */
  places: string[];
}

export interface Opened {
  /** The lines to show first: a resumed game's recent history, or the start of making a character. */
  lines: LogLine[];
  /** A saved game was carried on (its history shouldn't be read aloud again). */
  resumed: boolean;
  view: GameView;
  cast: Cast;
}

/** What came of something the player typed, and the game after it. */
export interface TurnOutcome extends TurnResult {
  view: GameView;
}

/**
 * Something the engine says between turns: the game has changed by itself (a picture of the place has been
 * drawn), or there's something the player should be told (pictures can't be drawn).
 */
export type GameEvent = { kind: "view"; view: GameView } | { kind: "notice"; text: string };

/**
 * A game engine, as a frontend drives it: pick a campaign, then send what the player types. One campaign is
 * open at a time; opening another leaves the first saved as it is.
 */
export interface Game {
  library(): Promise<Library>;
  /** Carries on the campaign's saved game ("continue"; a new character if it has none), or starts a new one. */
  open(campaignId: string, mode: "continue" | "new"): Promise<Opened>;
  /** Everything the player types: actions, speech and /commands. */
  submit(text: string): Promise<TurnOutcome>;
  /** Hears what the engine says between turns; returns what stops listening. */
  subscribe(listener: (event: GameEvent) => void): () => void;
  close(): Promise<void>;
}

export { formatBonus, statBonus } from "../world/checks.js";
export { clock } from "../world/time.js";
