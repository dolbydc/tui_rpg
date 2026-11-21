import type { GameState, LocationDef, LogLine, NpcDef, NpcMemory, NpcPlan, TimeOfDay } from "../domain/types.js";
import { ACTIONS_PER_TURN, type WorldEngine } from "./engine.js";
import { knowsPlayerName, memoriesOf, newMemory } from "./memory.js";
import { NOTICE } from "./perception.js";

/** How many places an NPC can cross in a turn: as many as the player can. */
export const NPC_STEPS = ACTIONS_PER_TURN;
/** How many of their memories an NPC weighs when deciding what to do, newest kept. */
const MEMORIES_WEIGHED = 15;

/** Everything an NPC knows of where they are, for deciding what to do next. */
export interface Situation {
  npc: NpcDef;
  place: LocationDef;
  exits: { direction: string; name: string }[];
  /** The other NPCs here. */
  people: NpcDef[];
  /** The player, if they're here: by name, if this NPC knows it. */
  stranger?: { name?: string; pronouns: string };
  items: string[];
  /** Lasting changes to this place. */
  notes: string[];
  /** Every place in the world, which they know their way around. */
  places: LocationDef[];
  /** Where their routine would have them about now, if they have one and it's elsewhere. */
  usual?: LocationDef;
  /** Travelling with the player. */
  companion: boolean;
  time: TimeOfDay;
  memories: NpcMemory[];
}

/** Who decides what to do next: everyone but the person the player is talking with (they're busy). */
export function deciders(world: WorldEngine, state: GameState): NpcDef[] {
  return [...world.world.npcs.values()].filter((npc) => npc.id !== state.conversation?.npcId);
}

export function situation(world: WorldEngine, state: GameState, memories: readonly NpcMemory[], npc: NpcDef): Situation {
  const at = world.npcLocation(npc, state);
  const place = world.location(at);
  const usual = npc.routine ? world.npcLocation(npc, { ...state, companions: [], npcPlaces: {} }) : undefined;
  return {
    npc,
    place,
    exits: Object.entries(place.exits).map(([direction, id]) => ({ direction, name: world.location(id).name })),
    people: world.npcsAt(at, state).filter((n) => n.id !== npc.id),
    ...(state.locationId === at && {
      stranger: {
        ...(knowsPlayerName(npc.id, memories) && { name: state.character.name }),
        pronouns: state.character.pronouns,
      },
    }),
    items: state.locationItems[at] ?? [],
    notes: state.locationNotes[at] ?? [],
    places: [...world.world.locations.values()],
    ...(usual && usual !== at && { usual: world.location(usual) }),
    companion: state.companions?.includes(npc.id) ?? false,
    time: world.time(state),
    memories: memoriesOf(npc.id, memories, MEMORIES_WEIGHED),
  };
}

export interface Enacted {
  state: GameState;
  /** What the NPCs remember of it: their own doings, and what they saw others do. */
  memories: NpcMemory[];
  /** What the player saw, if they were there. Moves aren't among them: they're announced as movements. */
  lines: LogLine[];
  /** Pairs who sought each other out to talk, to go first among the turn's conversations. */
  talks: [string, string][];
}

/**
 * Carries out what the NPCs decided, as the turn ends. Each plan was made a little earlier, so it's checked
 * against how things are now: someone they meant to talk to who's gone, or a companion told to stay, and the
 * plan comes to nothing.
 */
export function enact(world: WorldEngine, state: GameState, plans: readonly NpcPlan[]): Enacted {
  let next: GameState = { ...state, npcPlaces: { ...state.npcPlaces }, locationNotes: { ...state.locationNotes } };
  const memories: NpcMemory[] = [];
  const lines: LogLine[] = [];
  const talks: [string, string][] = [];
  const decided = new Set(deciders(world, state).map((n) => n.id));

  for (const plan of plans) {
    const npc = world.world.npcs.get(plan.npcId);
    if (!npc || !decided.has(npc.id)) continue;
    const at = world.npcLocation(npc, next);
    const companion = next.companions?.includes(npc.id) ?? false;
    // A change to the place is seen even if they didn't say how it looked being done.
    const doing = plan.doing.trim() || (plan.action === "change" ? plan.change.trim() : "");
    let to = at;
    let seen = Boolean(doing);

    switch (plan.action) {
      case "go":
      case "seek_player": {
        if (companion) continue;
        const target = plan.action === "go" ? plan.to : next.locationId;
        to = world.path(at, target).slice(0, NPC_STEPS).at(-1) ?? at;
        if (to === at) continue;
        next.npcPlaces = { ...next.npcPlaces, [npc.id]: to };
        seen = false;
        break;
      }
      case "leave_player": {
        if (!companion) continue;
        to = plan.to ? (world.path(at, plan.to).slice(0, NPC_STEPS).at(-1) ?? at) : at;
        next.companions = next.companions!.filter((id) => id !== npc.id);
        next.npcPlaces = { ...next.npcPlaces, [npc.id]: to };
        seen = to === at && Boolean(doing);
        break;
      }
      case "talk": {
        const other = world.world.npcs.get(plan.with);
        if (!other || world.npcLocation(other, next) !== at) continue;
        talks.push([npc.id, other.id]);
        break;
      }
      case "change": {
        const change = plan.change.trim();
        if (!change) continue;
        next.locationNotes = { ...next.locationNotes, [at]: [...(next.locationNotes[at] ?? []), change] };
        seen = true;
        break;
      }
      case "stay":
        break;
    }

    if (!doing) continue;
    const place = world.location(at);
    memories.push(newMemory(npc, { turn: state.turn, kind: "witnessed", about: npc.id, text: `${doing} (at ${place.name})` }));
    const witnesses = world.npcsAt(at, state).filter((n) => n.id !== npc.id && n.perception >= NOTICE.action);
    for (const witness of witnesses) {
      memories.push(newMemory(witness, { turn: state.turn, kind: "witnessed", about: npc.id, text: `Saw at ${place.name}: ${doing}` }));
    }
    if (seen && next.locationId === at) lines.push({ kind: "narration", text: doing });
  }
  return { state: next, memories, lines, talks };
}
