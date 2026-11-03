import { randomUUID } from "node:crypto";
import type { Discretion, NpcDef, NpcMemory, ShareLevel } from "../domain/types.js";

/** How freely an NPC passes on what they witness or hear, by temperament. */
export const DISCRETION_SHARE: Record<Discretion, ShareLevel> = {
  open: "public",
  guarded: "trusted",
  secretive: "secret",
};

const STRICTNESS: Record<ShareLevel, number> = { public: 0, trusted: 1, secret: 2 };

export function stricter(a: ShareLevel, b: ShareLevel): ShareLevel {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

type MemoryFields = Omit<NpcMemory, "id" | "npcId" | "share" | "origin"> & Partial<Pick<NpcMemory, "share" | "origin">>;

/** A new memory for an NPC. Shared according to their discretion unless stated; its own origin unless relayed. */
export function newMemory(npc: NpcDef, fields: MemoryFields): NpcMemory {
  const id = randomUUID();
  return {
    id,
    npcId: npc.id,
    ...fields,
    share: fields.share ?? DISCRETION_SHARE[npc.discretion],
    origin: fields.origin ?? id,
  };
}

/** The origin of the fact "the stranger's name is …", shared by everyone who learns it, however they learn it. */
export const PLAYER_NAME_ORIGIN = "player:name";

/** Until they learn the player's name, NPCs remember the player as "the stranger". */
export function knowsPlayerName(npcId: string, memories: readonly NpcMemory[]): boolean {
  return memories.some((m) => m.npcId === npcId && m.origin === PLAYER_NAME_ORIGIN);
}

/** One NPC's memories, newest last, optionally only the most recent. */
export function memoriesOf(npcId: string, memories: readonly NpcMemory[], limit?: number): NpcMemory[] {
  const own = memories.filter((m) => m.npcId === npcId);
  return limit === undefined ? own : own.slice(-limit);
}

/** What an NPC draws on when the player talks to them, by how they came to know it. */
export interface Recollection {
  /** Their own conversations with the player: what was said on both sides. */
  talked: NpcMemory[];
  /** What they saw or overheard themselves. */
  saw: NpcMemory[];
  /** What others told them. */
  heard: NpcMemory[];
}

/** How many of each kind of memory an NPC brings to a conversation, newest kept. */
export const RECALL = { talked: 20, saw: 12, heard: 15 } as const;

/**
 * One NPC's memories for a conversation with the player, oldest first in each group. Each kind has its own
 * allowance, so a busy evening of comings and goings can't push out what was said or what they've heard.
 */
export function recall(npcId: string, memories: readonly NpcMemory[]): Recollection {
  const own = memoriesOf(npcId, memories);
  return {
    talked: own.filter((m) => m.kind === "conversation" && m.about === "player").slice(-RECALL.talked),
    saw: own.filter((m) => m.kind === "witnessed").slice(-RECALL.saw),
    heard: own.filter((m) => m.kind === "heard" || (m.kind === "conversation" && m.about !== "player")).slice(-RECALL.heard),
  };
}

/** What an NPC has said to the player before, oldest first: kept word for word, or read back from older saves. */
export function pastReplies(talked: readonly NpcMemory[]): string[] {
  return talked.flatMap((m) => {
    const said = m.said ?? m.text.split(" replied: ")[1];
    return said ? [said] : [];
  });
}
