import type { GameState, NpcMemory, TurnRecord } from "../domain/types.js";
import type { CampaignStore, SavedCampaign, SaveSummary } from "./store.js";

interface Campaign {
  state: GameState;
  updatedAt: string;
  turns: TurnRecord[];
  memories: NpcMemory[];
}

export class InMemoryStore implements CampaignStore {
  private readonly campaigns = new Map<string, Campaign>();

  async load(campaignId: string, recentTurns = 10): Promise<SavedCampaign | undefined> {
    const campaign = this.campaigns.get(campaignId);
    if (!campaign) return undefined;
    return structuredClone({
      state: campaign.state,
      recent: campaign.turns.slice(-recentTurns),
      memories: campaign.memories,
    });
  }

  async commitTurn(state: GameState, record: TurnRecord, memories: NpcMemory[] = []): Promise<void> {
    const campaign = this.campaigns.get(state.campaignId) ?? { state, updatedAt: "", turns: [], memories: [] };
    campaign.state = structuredClone(state);
    campaign.updatedAt = new Date().toISOString();
    campaign.turns.push(structuredClone(record));
    campaign.memories.push(...structuredClone(memories));
    this.campaigns.set(state.campaignId, campaign);
  }

  async reset(campaignId: string): Promise<void> {
    this.campaigns.delete(campaignId);
  }

  async saves(): Promise<SaveSummary[]> {
    return [...this.campaigns.entries()]
      .map(([campaignId, { state, updatedAt }]) => ({ campaignId, characterName: state.character.name, turn: state.turn, updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async rename(from: string, to: string): Promise<void> {
    const campaign = this.campaigns.get(from);
    if (!campaign || this.campaigns.has(to)) return;
    campaign.state = { ...campaign.state, campaignId: to };
    this.campaigns.set(to, campaign);
    this.campaigns.delete(from);
  }

  async close(): Promise<void> {}
}
