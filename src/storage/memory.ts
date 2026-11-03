import type { GameState, NpcMemory, TurnRecord } from "../domain/types.js";
import type { CampaignStore, SavedCampaign } from "./store.js";

interface Campaign {
  state: GameState;
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
    const campaign = this.campaigns.get(state.campaignId) ?? { state, turns: [], memories: [] };
    campaign.state = structuredClone(state);
    campaign.turns.push(structuredClone(record));
    campaign.memories.push(...structuredClone(memories));
    this.campaigns.set(state.campaignId, campaign);
  }

  async reset(campaignId: string): Promise<void> {
    this.campaigns.delete(campaignId);
  }

  async close(): Promise<void> {}
}
