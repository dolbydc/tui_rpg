import type { GameState, NpcMemory, TurnRecord } from "../domain/types.js";

export interface SavedCampaign {
  state: GameState;
  /** The most recent turns, oldest first. */
  recent: TurnRecord[];
  /** Every NPC's memories, oldest first. */
  memories: NpcMemory[];
}

/** A saved game, as the start menu lists it. */
export interface SaveSummary {
  campaignId: string;
  characterName: string;
  turn: number;
  /** ISO 8601. */
  updatedAt: string;
}

/** Persists campaign state, the history of turns that produced it, and what each NPC remembers. */
export interface CampaignStore {
  load(campaignId: string, recentTurns?: number): Promise<SavedCampaign | undefined>;
  /** Saves the new state, its turn record and the turn's new NPC memories together, so they never disagree. */
  commitTurn(state: GameState, record: TurnRecord, memories?: NpcMemory[]): Promise<void>;
  /** Deletes a campaign and its history. */
  reset(campaignId: string): Promise<void>;
  /** Every saved game, most recently played first. */
  saves(): Promise<SaveSummary[]>;
  /** Moves a saved game, with its history and memories, to another id. Does nothing if `to` is taken. */
  rename(from: string, to: string): Promise<void>;
  close(): Promise<void>;
}
