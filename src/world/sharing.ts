import type { Clock, NpcDef, NpcMemory, ShareLevel } from "../domain/types.js";
import type { WorldEngine } from "./engine.js";
import { DISCRETION_SHARE, newMemory, stricter } from "./memory.js";

/** Something an NPC knows, whether from their definition or from memory. */
export interface Fact {
  origin: string;
  text: string;
  share: ShareLevel;
  about: string;
}

/** Turns NPCs who just talked wait before talking again. */
export const EXCHANGE_COOLDOWN = 3;
/** Most facts offered to the model per side, newest first. */
const MAX_OFFERED = 8;

/** Two co-located NPCs and what each is allowed to tell the other. */
export interface ExchangeCandidate {
  a: NpcDef;
  b: NpcDef;
  locationId: string;
  aToB: Fact[];
  bToA: Fact[];
}

export interface ExchangeChoice {
  aTells: Fact[];
  bTells: Fact[];
  /** One sentence as an onlooker would see it. */
  summary: string;
}

export function factsOf(npc: NpcDef, memories: readonly NpcMemory[]): Fact[] {
  return [
    ...npc.knowledge.map((k) => ({ origin: `knowledge:${npc.id}:${k.id}`, text: k.fact, share: k.share, about: "world" })),
    ...memories
      .filter((m) => m.npcId === npc.id)
      .map((m) => ({ origin: m.origin, text: m.text, share: m.share, about: m.about })),
  ];
}

export function canShare(share: ShareLevel, speaker: NpcDef, listener: NpcDef): boolean {
  return share === "public" || (share === "trusted" && speaker.trusts.includes(listener.id));
}

/** What the speaker may tell the listener that the listener doesn't already know, newest first. */
export function shareable(speaker: NpcDef, listener: NpcDef, memories: readonly NpcMemory[]): Fact[] {
  const known = new Set(factsOf(listener, memories).map((f) => f.origin));
  return factsOf(speaker, memories)
    .filter((f) => canShare(f.share, speaker, listener) && !known.has(f.origin) && f.about !== listener.id)
    .reverse()
    .slice(0, MAX_OFFERED);
}

/** The first pair of NPCs sharing a location this turn who haven't talked lately and have something to tell. */
export function findExchange(
  world: WorldEngine,
  memories: readonly NpcMemory[],
  clock: Clock,
): ExchangeCandidate | undefined {
  const { turn } = clock;
  const npcs = [...world.world.npcs.values()];
  for (const [i, a] of npcs.entries()) {
    for (const b of npcs.slice(i + 1)) {
      const locationId = world.npcLocation(a, clock);
      if (world.npcLocation(b, clock) !== locationId || talkedRecently(a, b, memories, turn)) continue;
      const aToB = shareable(a, b, memories);
      const bToA = shareable(b, a, memories);
      if (aToB.length || bToA.length) return { a, b, locationId, aToB, bToA };
    }
  }
  return undefined;
}

/** The memories an exchange leaves: what each heard, and that they talked. */
export function applyExchange(candidate: ExchangeCandidate, choice: ExchangeChoice, turn: number): NpcMemory[] {
  const { a, b } = candidate;
  const heard = (listener: NpcDef, speaker: NpcDef, fact: Fact) =>
    newMemory(listener, {
      turn,
      kind: "heard",
      about: fact.about,
      text: fact.text,
      origin: fact.origin,
      // Passed-on information is never handled more loosely than its teller handled it.
      share: stricter(fact.share, DISCRETION_SHARE[listener.discretion]),
      source: { npcId: speaker.id, name: speaker.name },
    });
  const talked = (npc: NpcDef, other: NpcDef) =>
    newMemory(npc, {
      turn,
      kind: "conversation",
      about: other.id,
      text: `Talked with ${other.name}.${choice.summary ? ` ${choice.summary}` : ""}`,
    });
  return [
    ...choice.aTells.map((fact) => heard(b, a, fact)),
    ...choice.bTells.map((fact) => heard(a, b, fact)),
    talked(a, b),
    talked(b, a),
  ];
}

function talkedRecently(a: NpcDef, b: NpcDef, memories: readonly NpcMemory[], turn: number): boolean {
  return memories.some(
    (m) => m.npcId === a.id && m.kind === "conversation" && m.about === b.id && turn - m.turn < EXCHANGE_COOLDOWN,
  );
}
