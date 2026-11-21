import type { WorldDefinition } from "../domain/types.js";
import type { Cutouts } from "../art/cutout.js";
import type { Illustrator, Subject } from "../art/illustrator.js";
import type { CampaignLibrary, OpenCampaign } from "../game/campaigns.js";
import type { SessionController } from "../game/session.js";
import { npcLabel } from "../narrative/describe.js";
import type { Cast, Game, GameEvent, GameView, Library, Opened, TurnOutcome } from "./api.js";

export interface LocalGameOptions {
  /** Draws pictures of places that haven't one of their own; without it, they go without. */
  illustrator?: Illustrator;
  /** Cuts people's portraits out of their backgrounds; without it, they're shown as drawn. */
  cutouts?: Cutouts;
  /** Views carry the game's minds (behind the scenes), for a frontend that shows them. */
  minds?: boolean;
  /** Closes what the engine was built on (its store), once the game is closed. */
  onClose?: () => Promise<void>;
}

/** The engine in this process: the campaign library and the session of whichever campaign is open. */
export class LocalGame implements Game {
  private current?: OpenCampaign;
  private readonly listeners = new Set<(event: GameEvent) => void>();

  constructor(
    private readonly campaigns: CampaignLibrary,
    private readonly options: LocalGameOptions = {},
  ) {}

  async library(): Promise<Library> {
    return {
      campaigns: this.campaigns.campaigns.map(({ id, title, tagline }) => ({ id, title, ...(tagline && { tagline }) })),
      saves: await this.campaigns.saves(),
    };
  }

  async open(campaignId: string, mode: "continue" | "new"): Promise<Opened> {
    const current = await this.campaigns.get(campaignId);
    const { session, world } = current;
    this.current = current;
    const resumed = mode === "continue" ? await session.resume() : undefined;
    // A saved game that's gone missing since the menu was drawn gets a new character, like any new game.
    const lines = resumed ?? session.newCharacter();
    return { lines, resumed: resumed !== undefined, view: this.view(), cast: castOf(world.world) };
  }

  async submit(text: string): Promise<TurnOutcome> {
    if (!this.current) throw new Error("No campaign is open");
    const result = await this.current.session.submit(text);
    return { ...result, view: this.view() };
  }

  subscribe(listener: (event: GameEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Tells every listener. */
  emit(event: GameEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** A picture has been drawn: if it's of where the player is now, or someone with them, the view has changed. */
  pictureReady(campaignId: string, subject: Subject): void {
    if (this.current?.info.id !== campaignId || !this.current.session.playing) return;
    const view = this.view();
    const player = view.player;
    const shown = subject.kind === "place" ? player?.place.id === subject.id : player?.people.some((p) => p.id === subject.id);
    // A place drawn elsewhere still changes the map, which shows it.
    if (shown || subject.kind === "place") this.emit({ kind: "view", view });
  }

  /** Pictures can't be drawn: the player is told, and the place no longer waits for one. */
  picturesFailed(err: Error): void {
    this.emit({ kind: "notice", text: `Pictures are off: ${err.message}` });
    if (this.current?.session.playing) this.emit({ kind: "view", view: this.view() });
  }

  /** A portrait has been cut out: if they're where the player is, the view has changed. */
  cutoutReady(campaignId: string, npcId: string): void {
    if (this.current?.info.id !== campaignId || !this.current.session.playing) return;
    const view = this.view();
    if (view.player?.people.some((p) => p.id === npcId)) this.emit({ kind: "view", view });
  }

  async close(): Promise<void> {
    this.options.illustrator?.close();
    this.options.cutouts?.close();
    await this.options.onClose?.();
  }

  /**
   * The game as the player sees it, with pictures: the place's and each person's own, or ones drawn before, or
   * (for where the player is and who they can see) ones to draw. The map shows each place's picture once there is one.
   */
  private view(): GameView {
    const { session, info, world } = this.current!;
    const view = viewOf(session, this.options.minds);
    const { illustrator, cutouts } = this.options;
    const player = view.player;
    if (!player) return view;
    // Everyone here with a portrait has it cut out, ready for when the player talks with them.
    const cut = () => {
      for (const person of player.people) {
        const cutout = person.image && cutouts?.of(info.id, person.id, person.image);
        if (cutout) person.cutout = cutout;
      }
    };
    if (!illustrator) {
      cut();
      return view;
    }
    const draw = (subject: Subject, target: { image?: string; drawing?: boolean }) => {
      if (target.image) return;
      const drawn = illustrator.picture(info.id, world.world, subject);
      if (drawn) target.image = drawn;
      else if (illustrator.pending(info.id, subject)) target.drawing = true;
    };
    draw({ kind: "place", id: player.place.id }, player.place);
    for (const person of player.people) draw({ kind: "person", id: person.id }, person);
    cut();
    // Portraits of minds elsewhere are shown if they've been drawn, but not drawn for that.
    for (const agent of view.minds?.agents ?? []) {
      agent.image ??= illustrator.drawn(info.id, { kind: "person", id: agent.id });
      if (!agent.image) delete agent.image;
    }
    for (const cell of player.map.cells) {
      if (cell.here) cell.image = player.place.image;
      else cell.image ??= world.world.locations.get(cell.id)?.image ?? illustrator.drawn(info.id, { kind: "place", id: cell.id });
      if (!cell.image) delete cell.image;
    }
    return view;
  }
}

/** What the player sees of the session: who's here as the player knows them, never what they don't. */
export function viewOf(session: SessionController, minds = false): GameView {
  const view: GameView = { title: session.title, ...(session.music && { music: session.music }) };
  if (!session.playing) return view;
  const scene = session.scene;
  const talking = session.talking;
  return {
    ...view,
    player: {
      place: { id: scene.location.id, name: scene.location.name, ...(scene.location.image && { image: scene.location.image }) },
      people: scene.npcs.map((npc) => ({
        id: npc.id,
        label: npcLabel(npc, scene.knownNpcs),
        appearance: npc.appearance,
        known: scene.knownNpcs.includes(npc.id),
        ...(scene.companions.includes(npc.id) && { companion: true }),
        ...(npc.image && { image: npc.image }),
        ...(talking.ids.includes(npc.id) && { talking: true }),
        ...(talking.speaking === npc.id && { speaking: true }),
      })),
      character: scene.character,
      quests: scene.quests.filter((q) => q.status !== "pending"),
      map: session.map,
      status: session.status,
    },
    ...(minds && { minds: session.minds }),
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
