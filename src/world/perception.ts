import type { GameState, Intent, NpcDef, NpcMemory, WorldEvent } from "../domain/types.js";
import { bareItem, withArticle, wordIn, type WorldEngine } from "./engine.js";
import { knowsPlayerName, newMemory, PLAYER_NAME_ORIGIN } from "./memory.js";

/** The perception (1–5) an NPC needs to notice each kind of thing. Talking to them is always remembered. */
export const NOTICE = {
  /** The player arriving or leaving. */
  presence: 2,
  /** Which way the player went when they left. */
  direction: 3,
  /** The player picking something up or handing it over. */
  item: 3,
  /** Anything else the player does in front of them. */
  action: 3,
  /** The player's conversation with someone else. */
  overhear: 4,
} as const;

const COMPASS = new Set(["north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest", "up", "down"]);

export interface WitnessedTurn {
  before: GameState;
  after: GameState;
  intent: Intent;
  events: WorldEvent[];
  /** What the player typed; an introduction is spotted here as well as in the interpreted message. */
  input: string;
  /** Set when the player talked to an NPC this turn. */
  dialogue?: { npc: NpcDef; said: string; reply: string };
  /** Everyone's memories so far, to tell who already knows the player's name. */
  known: readonly NpcMemory[];
}

/**
 * What each NPC present noticed of the player's turn, as new memories. The player is "the stranger" in
 * them; NPCs learn the name only when the player says it to them (or within earshot), and pass it on.
 */
export function observe(world: WorldEngine, turn: WitnessedTurn): NpcMemory[] {
  const { before, after, intent, events, dialogue, input, known } = turn;
  const name = before.character.name;
  const here = world.location(before.locationId);
  // People at the scene when the player acted, before anyone moved on.
  const present = world.npcsAt(here.id, before);
  const memories: NpcMemory[] = [];
  // Sneaking: if it worked (success or partial success) nobody notices the player come, go or do anything
  // this action (whoever they speak to or hand something still knows). If it partly failed they're seen
  // as usual; if it failed outright, whoever sees them also sees they were sneaking.
  const sneak = events.find((e) => e.type === "checked" && e.check.stealth);
  const outcome = sneak?.type === "checked" ? sneak.check.outcome : undefined;
  const unseen = outcome === "success" || outcome === "partial_success";
  const witnesses = new Set<NpcDef>();
  const noted = (npc: NpcDef, kind: NpcMemory["kind"], text: string, said?: string) => {
    if (unseen && kind === "witnessed") return;
    if (kind === "witnessed") witnesses.add(npc);
    memories.push(newMemory(npc, { turn: before.turn, kind, about: "player", text, ...(said && { said }) }));
  };

  for (const event of events) {
    switch (event.type) {
      case "moved": {
        // Each step of a journey is seen by whoever is at that step, not only where it began.
        const from = world.location(event.from);
        const destination = world.location(event.to);
        const leaving = from.id === here.id ? present : world.npcsAt(from.id, before);
        const exit = Object.entries(from.exits).find(([, target]) => target === event.to)?.[0] ?? "";
        const heading = COMPASS.has(exit) ? `heading ${exit} toward` : "heading for";
        for (const npc of leaving) {
          if (npc.perception >= NOTICE.direction) {
            noted(npc, "witnessed", `The stranger left ${from.name}, ${heading} ${destination.name}.`);
          } else if (npc.perception >= NOTICE.presence) {
            noted(npc, "witnessed", `The stranger left ${from.name}.`);
          }
        }
        for (const npc of world.npcsAt(destination.id, after)) {
          if (npc.perception >= NOTICE.presence && !leaving.includes(npc)) {
            noted(npc, "witnessed", `The stranger arrived at ${destination.name} from ${from.name}.`);
          }
        }
        break;
      }
      case "item_taken":
        for (const npc of present) {
          if (npc.perception >= NOTICE.item) {
            noted(npc, "witnessed", `The stranger picked up the ${bareItem(event.item)} at ${here.name}.`);
          }
        }
        break;
      case "item_dropped":
        for (const npc of present) {
          if (npc.perception >= NOTICE.item) {
            noted(npc, "witnessed", `The stranger put down ${withArticle(bareItem(event.item))} at ${here.name}.`);
          }
        }
        break;
      case "item_given": {
        const recipient = world.npc(event.npcId);
        noted(recipient, "conversation", `The stranger gave ${recipient.name} ${withArticle(event.item)}.`);
        for (const npc of present) {
          if (npc !== recipient && npc.perception >= NOTICE.item) {
            noted(npc, "witnessed", `The stranger gave ${recipient.name} ${withArticle(event.item)} at ${here.name}.`);
          }
        }
        break;
      }
    }
  }

  if (intent.kind === "act") {
    for (const npc of present) {
      if (npc.perception >= NOTICE.action) noted(npc, "witnessed", `At ${here.name}, the stranger attempted: ${intent.action}`);
    }
  }

  if (dialogue) {
    const { npc: addressed, said } = dialogue;
    const reply = clip(dialogue.reply);
    const hearers = present.filter((npc) => npc !== addressed && npc.perception >= NOTICE.overhear);
    // The one spoken to keeps their own words in full, so they can avoid saying them again.
    const own = clip(dialogue.reply, 800);
    noted(addressed, "conversation", `The stranger said to ${addressed.name}: "${said}" ${addressed.name} replied: ${own}`, own);
    for (const npc of hearers) {
      noted(npc, "witnessed", `Overheard the stranger say to ${addressed.name}: "${said}" ${addressed.name} replied: ${reply}`);
    }
    // Saying their own name introduces the player to whoever hears it.
    if (wordIn(`${input} ${said}`, name)) {
      for (const npc of [addressed, ...hearers]) {
        if (knowsPlayerName(npc.id, known)) continue;
        memories.push(
          newMemory(npc, {
            turn: before.turn,
            kind: npc === addressed ? "conversation" : "witnessed",
            about: "player",
            text: `The stranger's name is ${name}.`,
            origin: PLAYER_NAME_ORIGIN,
          }),
        );
      }
    }
  }
  if (outcome === "failure" && sneak?.type === "checked") {
    for (const npc of witnesses) {
      memories.push(
        newMemory(npc, {
          turn: before.turn,
          kind: "witnessed",
          about: "player",
          text: `Caught the stranger sneaking, trying to ${sneak.check.why}. They're up to something, and not to be trusted.`,
        }),
      );
    }
  }
  return memories;
}

function clip(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
