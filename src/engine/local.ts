import type { WorldDefinition } from "../domain/types.js";
import type { CampaignLibrary } from "../game/campaigns.js";
import type { SessionController } from "../game/session.js";
import { npcLabel } from "../narrative/describe.js";
import type { Cast, Game, GameView, Library, Opened, TurnOutcome } from "./api.js";

/** The engine in this process: the campaign library and the session of whichever campaign is open. */
export class LocalGame implements Game {
  private session?: SessionController;

  constructor(
    private readonly campaigns: CampaignLibrary,
    /** Closes what the engine was built on (its store), once the game is closed. */
    private readonly onClose: () => Promise<void> = async () => {},
  ) {}

  async library(): Promise<Library> {
    return {
      campaigns: this.campaigns.campaigns.map(({ id, title, tagline }) => ({ id, title, ...(tagline && { tagline }) })),
      saves: await this.campaigns.saves(),
    };
  }

  async open(campaignId: string, mode: "continue" | "new"): Promise<Opened> {
    const { session, world } = await this.campaigns.get(campaignId);
    this.session = session;
    const resumed = mode === "continue" ? await session.resume() : undefined;
    // A saved game that's gone missing since the menu was drawn gets a new character, like any new game.
    const lines = resumed ?? session.newCharacter();
    return { lines, resumed: resumed !== undefined, view: viewOf(session), cast: castOf(world.world) };
  }

  async submit(text: string): Promise<TurnOutcome> {
    const session = this.session;
    if (!session) throw new Error("No campaign is open");
    const result = await session.submit(text);
    return { ...result, view: viewOf(session) };
  }

  async close(): Promise<void> {
    await this.onClose();
  }
}

/** What the player sees of the session: who's here as the player knows them, never what they don't. */
export function viewOf(session: SessionController): GameView {
  const view: GameView = { title: session.title, ...(session.music && { music: session.music }) };
  if (!session.playing) return view;
  const scene = session.scene;
  return {
    ...view,
    player: {
      place: { id: scene.location.id, name: scene.location.name, ...(scene.location.image && { image: scene.location.image }) },
      people: scene.npcs.map((npc) => ({
        id: npc.id,
        label: npcLabel(npc, scene.knownNpcs),
        appearance: npc.appearance,
        known: scene.knownNpcs.includes(npc.id),
        ...(npc.image && { image: npc.image }),
      })),
      character: scene.character,
      quests: scene.quests.filter((q) => q.status !== "pending"),
      map: session.map,
      status: session.status,
    },
  };
}

export function castOf(world: WorldDefinition): Cast {
  return {
    ...(world.narratorVoice && { narratorVoice: world.narratorVoice }),
    npcs: Object.fromEntries(
      [...world.npcs.values()].map((npc) => [npc.id, { pronouns: npc.pronouns, ...(npc.voice && { voice: npc.voice }) }]),
    ),
    places: [...world.locations.values()].map((l) => l.name),
  };
}
