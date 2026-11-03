import type { Character, CheckResult, Intent, LocationDef, Quest, LogLine, NpcDef, NpcMovement, Resolved, SceneView, WorldEvent } from "../domain/types.js";
import { DRIVE_PER_QUEST } from "../world/checks.js";
import { clock, describeTime } from "../world/time.js";
import { bareItem, escapeRegExp, nameForms, withArticle } from "../world/engine.js";

/** How the player refers to an NPC: by name once they know it, otherwise by epithet ("the old man"). */
export function npcLabel(npc: NpcDef, known: readonly string[]): string {
  return known.includes(npc.id) ? npc.name : npc.epithet;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Puts LLM output into the player's terms: NPC lines are attributed by label, and names the player
 * hasn't learned are replaced with epithets everywhere except in what NPCs say aloud (which is how
 * the player learns them).
 */
export function presentToPlayer(lines: LogLine[], npcs: readonly NpcDef[], known: readonly string[]): LogLine[] {
  const unknown = npcs.filter((npc) => !known.includes(npc.id));
  const mask = (text: string) => maskNames(text, unknown);
  return lines.map((line) => {
    if (line.kind === "narration") return { ...line, text: mask(line.text) };
    if (line.kind !== "npc") return line;
    const npc = npcs.find((n) => n.id === line.npcId);
    return {
      ...line,
      speaker: npc ? capitalize(npcLabel(npc, known)) : line.speaker,
      // Only *actions* are masked; speech stays as said.
      text: line.text.replace(/\*[^*]*\*/g, mask),
    };
  });
}

/** Replaces each NPC's name (in full, then by its parts) with their epithet, capitalized at a sentence start. */
function maskNames(text: string, npcs: readonly NpcDef[]): string {
  let masked = text;
  for (const npc of npcs) {
    for (const form of nameForms(npc)) {
      masked = masked.replace(new RegExp(`\\b${escapeRegExp(form)}\\b`, "g"), (_match, offset: number, whole: string) =>
        /(^|[.!?*]\s*|^\s*)$/.test(whole.slice(0, offset)) ? capitalize(npc.epithet) : npc.epithet,
      );
    }
  }
  return masked;
}

/**
 * Plain-text scene description, for the player or (`forModel`) as LLM context, which also gives each
 * person's pronouns so narration doesn't guess them.
 */
export function describeScene(scene: SceneView, { forModel = false } = {}): string {
  const lines = [scene.location.name, scene.location.description];
  // The model must know the time, or it guesses (dusk the morning after a night's sleep).
  if (forModel) lines.push(`Time: ${describeTime(scene.time)}. Keep light, weather and what people say consistent with it.`);
  if (scene.exits.length) {
    lines.push(`Exits: ${scene.exits.map((e) => `${e.direction} (${e.name})`).join(", ")}`);
  }
  if (scene.npcs.length) {
    const people = scene.npcs.map((n) => {
      const who = scene.knownNpcs.includes(n.id) ? n.name : n.appearance;
      return forModel ? `${who} (${n.pronouns})` : who;
    });
    lines.push(`People here: ${people.join("; ")}`);
  }
  if (scene.items.length) lines.push(`You see: ${scene.items.join(", ")}`);
  if (scene.notes.length) lines.push(`Changed: ${scene.notes.join(" ")}`);
  return lines.join("\n");
}

/** "The player made their way from The Hollow Lantern by way of Brackenford Square to Edge of the Thornwood." */
function journey(moves: WorldEvent[], scene: SceneView): string {
  const name = (id: string) => (id === scene.location.id ? scene.location.name : scene.knownPlaces.find((p) => p.id === id)?.name ?? id);
  const stops = moves.flatMap((m) => (m.type === "moved" ? [m.to] : []));
  const from = moves[0].type === "moved" ? name(moves[0].from) : "";
  const via = stops.slice(0, -1).map(name);
  return `The player made their way from ${from}${via.length ? ` by way of ${via.join(", then ")}` : ""} to ${name(stops.at(-1)!)}, a familiar path.`;
}

/** Describes an outcome without the LLM, for explicit slash commands. */
export function describeOutcome(intent: Intent, resolution: Resolved, scene: SceneView): LogLine[] {
  const [event] = resolution.events;
  if (event?.type === "item_taken") return [{ kind: "narration", text: `You take the ${bareItem(event.item)}.` }];
  if (event?.type === "item_given" && resolution.npc) {
    return [{ kind: "narration", text: `You give ${npcLabel(resolution.npc, scene.knownNpcs)} ${withArticle(event.item)}.` }];
  }
  if (event?.type === "item_dropped") {
    return [{ kind: "narration", text: `You put down ${withArticle(bareItem(event.item))}.` }];
  }
  if (intent.kind === "wait") return [{ kind: "narration", text: "You wait a while." }];
  const moves = resolution.events.filter((e) => e.type === "moved");
  if (moves.length > 1) {
    const via = moves.slice(0, -1).flatMap((m) => (m.type === "moved" ? [scene.knownPlaces.find((p) => p.id === m.to)?.name ?? m.to] : []));
    return [
      { kind: "narration", text: `You make your way there by way of ${via.join(", then ")}.` },
      { kind: "narration", text: describeScene(scene) },
    ];
  }
  if (intent.kind === "search") {
    const found = resolution.events.flatMap((e) => (e.type === "item_found" ? [withArticle(bareItem(e.item))] : []));
    return [{ kind: "narration", text: found.length ? `You search, and find ${found.join(" and ")}.` : "You search, but find nothing." }];
  }
  if (intent.kind === "sleep") {
    return [{ kind: "narration", text: `You sleep through the night, and wake at ${clock(scene.time.minutes)}.` }];
  }
  return [{ kind: "narration", text: describeScene(scene) }];
}

/** States what the world engine decided, as authoritative input for the narrator. */
export function describeEvents(events: WorldEvent[], scene: SceneView, npc?: NpcDef): string[] {
  const moves = events.filter((e) => e.type === "moved");
  return events.flatMap((event) => {
    switch (event.type) {
      case "moved":
        if (moves.length === 1) return `The player moved to ${scene.location.name}, one step, and is there now.`;
        // A journey along known paths: told once, at its first step.
        return event === moves[0] ? `${journey(moves, scene)} They are at ${scene.location.name} now.` : [];
      case "item_taken":
        return `The player picked up the ${bareItem(event.item)}; it is now in their inventory.`;
      case "item_dropped":
        return `The player put down ${withArticle(bareItem(event.item))}; it now lies here, out of their inventory.`;
      case "item_found": {
        const hidden = scene.location.hiddenItems.find((h) => h.item === event.item);
        const where = hidden?.hidden ? ` (it was ${hidden.hidden})` : "";
        const notice = hidden?.found ? ` On finding it, the player notices: ${hidden.found}` : "";
        return `Searching, the player finds ${withArticle(bareItem(event.item))}${where}. It now lies in plain sight; they haven't picked it up.${notice}`;
      }
      case "item_given":
        return `The player gave ${npc ? npcLabel(npc, scene.knownNpcs) : "someone"} ${withArticle(event.item)}; it is now theirs.`;
      case "quest_completed": {
        const title = scene.quests.find((q) => q.id === event.questId)?.title ?? event.questId;
        return `This completes the player's quest "${title}".`;
      }
      case "levelled_up":
        return `The player has grown more capable (${event.stat} improved).`;
      case "checked":
        return checkOutcome(event.check);
      // Hidden from the narrator until they surface; quests starting are announced to the player directly.
      case "quest_started":
      case "complication_pending":
      case "complication_resolved":
        return [];
    }
  });
}

/** The one rule about rolls: the player never learns of them. */
export const NO_DICE = "Never mention dice, rolls, numbers or checks.";

/** How a rolled attempt turned out, for the narrator. A partial success must read as a success. */
export function checkOutcome({ why, outcome }: CheckResult): string {
  switch (outcome) {
    case "success":
      return `The player's attempt to ${why} succeeds cleanly.`;
    case "partial_success":
      return `The player's attempt to ${why} succeeds, as far as anyone can tell. Narrate it as a success; don't hint at any catch.`;
    case "partial_failure":
      return `The player's attempt to ${why} falls short, but not disastrously: they get something out of it (some progress, a clue, a second chance), or it simply doesn't work without making things worse.`;
    case "failure":
      return `The player's attempt to ${why} fails outright and leaves them worse off (noticed, outmanoeuvred, at a disadvantage), though they are not hurt and lose nothing: the world engine hasn't decided that.`;
  }
}

/** How a rolled attempt lands on the NPC it's aimed at, for their reply. A partial success fools them, for now. */
export function checkOnNpc({ why, outcome }: CheckResult): string {
  const attempt = `The stranger is trying to ${why}.`;
  switch (outcome) {
    case "success":
    case "partial_success":
      return `${attempt} It works on you: you are convinced, swayed or cowed, as fits, and act on it.`;
    case "partial_failure":
      return `${attempt} It doesn't quite work: you are unconvinced or unmoved, though not offended.`;
    case "failure":
      return `${attempt} It fails badly: you see straight through it or take offence, and trust the stranger less for it.`;
  }
}

/**
 * Announces completed quests and what they paid, says when there's enough experience to level up, and
 * announces quests that have started (which restore drive).
 */
export function describeRewards(events: WorldEvent[], quests: Quest[], character: Character, levelCost: number): LogLine[] {
  const lines: LogLine[] = [];
  const title = (id: string) => quests.find((q) => q.id === id)?.title ?? id;
  let completed = false;
  for (const event of events) {
    if (event.type === "quest_completed") {
      completed = true;
      const gains = [...(event.reward.xp ? [`${event.reward.xp} XP`] : []), ...event.reward.items];
      lines.push({ kind: "system", text: `Quest complete: ${title(event.questId)}.${gains.length ? ` Reward: ${gains.join(", ")}.` : ""}` });
    }
    if (event.type === "quest_started") {
      lines.push({ kind: "system", text: `New quest: ${title(event.questId)}. Your drive is restored (${DRIVE_PER_QUEST}).` });
    }
  }
  if (completed && character.xp >= levelCost) {
    lines.push({ kind: "system", text: `You have enough experience to reach level ${character.level + 1}: /levelup <stat>.` });
  }
  return lines;
}

/** NPCs coming and going within the player's sight, told plainly so nobody appears from nowhere. */
export function describeMovements(
  movements: NpcMovement[],
  location: (id: string) => LocationDef,
  known: readonly string[],
): LogLine[] {
  return movements.map(({ npc, from, to, kind }) => {
    const who = capitalize(npcLabel(npc, known));
    switch (kind) {
      case "arrived":
        return { kind: "narration", text: `${who} arrives from ${location(from).name}.` };
      case "followed":
        return { kind: "narration", text: `${who} follows you from ${location(from).name}.` };
      case "left":
        return { kind: "narration", text: `${who} leaves for ${location(to).name}.` };
    }
  });
}

export function formatRecent(lines: LogLine[]): string {
  if (!lines.length) return "(none)";
  return lines
    .map((line) => {
      switch (line.kind) {
        case "player":
          return `Player: ${line.text}`;
        case "npc":
          return `${line.speaker ?? "NPC"}: ${line.text}`;
        default:
          return line.text;
      }
    })
    .join("\n");
}
