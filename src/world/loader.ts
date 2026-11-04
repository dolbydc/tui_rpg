import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { layoutMap, MAP_LABEL, mapLabel } from "./map.js";
import { parseClock } from "./time.js";
import type {
  Character,
  CheckRequest,
  GridPosition,
  HiddenItemDef,
  Discretion,
  KnowledgeDef,
  LocationDef,
  NpcDef,
  QuestCondition,
  QuestDef,
  Reward,
  ShareLevel,
  WorldDefinition,
} from "../domain/types.js";

/**
 * Loads a campaign directory:
 *   world.md            title, starting state (incl. start_time), music, quests with their definition of done and reward
 *                       (frontmatter) and intro (body)
 *   rules.md            narrator tone and rules (body)
 *   locations/<id>.md   name, label and map position (optional), exits, items, hidden_items, arrival_check, music
 *                       (frontmatter) and description (body)
 * Music is an audio file's path, from the campaign directory; a location's `music: none` is silence.
 *   npcs/<id>.md        name, epithet, appearance, pronouns, voice, speech, location, routine, perception, discretion,
 *                       goals, knowledge, trusts (frontmatter) and persona (body)
 */
export async function loadWorld(dir: string): Promise<WorldDefinition> {
  const worldFile = path.join(dir, "world.md");
  const world = parseMarkdown(await readFile(worldFile, "utf8"));
  const rules = parseMarkdown(await readFile(path.join(dir, "rules.md"), "utf8").catch(() => ""));

  const locations = new Map<string, LocationDef>();
  const fixed = new Map<string, GridPosition>();
  for (const [id, file, doc] of await loadDocs(path.join(dir, "locations"))) {
    const name = str(doc.data, "name", file);
    const label = doc.data.label === undefined ? mapLabel(name) : str(doc.data, "label", file);
    if (label.length > MAP_LABEL) throw new Error(`${file}: "label" must be at most ${MAP_LABEL} characters`);
    if (doc.data.map !== undefined) fixed.set(id, position(doc.data.map, file));
    locations.set(id, {
      id,
      name,
      label,
      position: { x: 0, y: 0, z: 0 },
      description: unwrap(doc.body),
      exits: strRecord(doc.data.exits ?? {}, "exits", file),
      items: strList(doc.data.items ?? [], "items", file),
      hiddenItems: hiddenItems(doc.data.hidden_items ?? [], file),
      ...(doc.data.arrival_check === undefined ? {} : { enterCheck: checkRequest(doc.data.arrival_check, file) }),
      ...(doc.data.music === undefined ? {} : { music: await music(doc.data, dir, file) }),
    });
  }

  const npcs = new Map<string, NpcDef>();
  for (const [id, file, doc] of await loadDocs(path.join(dir, "npcs"))) {
    const { data } = doc;
    npcs.set(id, {
      id,
      name: str(data, "name", file),
      epithet: data.epithet === undefined ? "someone" : str(data, "epithet", file),
      appearance: data.appearance === undefined ? "someone you don't know" : str(data, "appearance", file),
      pronouns: data.pronouns === undefined ? "they/them" : str(data, "pronouns", file),
      ...(data.voice === undefined ? {} : { voice: str(data, "voice", file) }),
      ...(data.speech === undefined ? {} : { speech: str(data, "speech", file).trim() }),
      locationId: str(data, "location", file),
      routine: data.routine === undefined ? undefined : strList(data.routine, "routine", file),
      persona: unwrap(doc.body),
      perception: data.perception === undefined ? 2 : num(data, "perception", file),
      discretion: oneOf<Discretion>(data.discretion ?? "guarded", ["open", "guarded", "secretive"], "discretion", file),
      goals: strList(data.goals ?? [], "goals", file),
      knowledge: knowledge(data.knowledge ?? [], file),
      trusts: strList(data.trusts ?? [], "trusts", file),
    });
  }

  const questDefs = quests(world.data.quests ?? [], worldFile);
  const definition: WorldDefinition = {
    id: path.basename(dir),
    title: str(world.data, "title", worldFile),
    intro: unwrap(world.body),
    rules: rules.body,
    ...(world.data.narrator_voice === undefined ? {} : { narratorVoice: str(world.data, "narrator_voice", worldFile) }),
    ...(world.data.music === undefined ? {} : { music: (await music(world.data, dir, worldFile, false)) ?? undefined }),
    start: {
      locationId: str(world.data, "start", worldFile),
      time: startTime(world.data.start_time, worldFile),
      character: character(world.data.character, worldFile),
      quests: questDefs.map(({ id, title, description, starts }) => ({
        id,
        title,
        description,
        status: starts.length ? "pending" : "active",
      })),
    },
    locations,
    npcs,
    quests: new Map(questDefs.map((q) => [q.id, q])),
  };
  validate(definition);
  const layout = layoutMap(
    [...locations.values()].map((l) => ({ id: l.id, exits: l.exits, map: fixed.get(l.id) })),
    definition.start.locationId,
  );
  for (const location of locations.values()) location.position = layout.get(location.id)!;
  return definition;
}

interface MarkdownDoc {
  data: Record<string, unknown>;
  body: string;
}

export function parseMarkdown(text: string): MarkdownDoc {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text.trim() };
  const data: unknown = parseYaml(match[1]) ?? {};
  if (!isRecord(data)) throw new Error("Frontmatter must be a YAML mapping");
  return { data, body: match[2].trim() };
}

/** Joins hard-wrapped lines into paragraphs so the TUI can wrap prose to its own width. */
function unwrap(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " "))
    .join("\n\n");
}

async function loadDocs(dir: string): Promise<[id: string, file: string, doc: MarkdownDoc][]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  return Promise.all(
    names.map(async (name): Promise<[string, string, MarkdownDoc]> => {
      const file = path.join(dir, name);
      return [path.basename(name, ".md"), file, parseMarkdown(await readFile(file, "utf8"))];
    }),
  );
}

function validate(world: WorldDefinition): void {
  const known = (id: string, what: string) => {
    if (!world.locations.has(id)) throw new Error(`${what} refers to unknown location "${id}"`);
  };
  known(world.start.locationId, "world.md start");
  for (const location of world.locations.values()) {
    for (const [exit, target] of Object.entries(location.exits)) known(target, `Exit "${exit}" of ${location.id}`);
  }
  for (const npc of world.npcs.values()) {
    known(npc.locationId, `NPC ${npc.id}`);
    for (const id of npc.routine ?? []) known(id, `Routine of NPC ${npc.id}`);
    if (npc.routine?.length === 0) throw new Error(`NPC ${npc.id}: routine must not be empty`);
    for (const id of npc.trusts) {
      if (!world.npcs.has(id)) throw new Error(`NPC ${npc.id} trusts unknown NPC "${id}"`);
    }
  }
  const stats = Object.keys(world.start.character.stats);
  for (const location of world.locations.values()) {
    if (location.enterCheck && !stats.includes(location.enterCheck.stat)) {
      throw new Error(`${location.id}: arrival_check stat "${location.enterCheck.stat}" isn't one of ${stats.join(", ")}`);
    }
    for (const hidden of location.hiddenItems) {
      if (hidden.check && !stats.includes(hidden.check.stat)) {
        throw new Error(`${location.id}: hidden item "${hidden.item}" check stat "${hidden.check.stat}" isn't one of ${stats.join(", ")}`);
      }
    }
  }
  for (const quest of world.quests.values()) {
    for (const condition of [...quest.starts, ...quest.done]) {
      const what = `Quest ${quest.id}: "${condition.kind}"`;
      if (condition.kind === "at" || condition.kind === "visited") known(condition.locationId, what);
      if ((condition.kind === "gave" || condition.kind === "knows") && !world.npcs.has(condition.npcId)) {
        throw new Error(`${what} refers to unknown NPC "${condition.npcId}"`);
      }
      if (condition.kind === "completed" && !world.quests.has(condition.questId)) {
        throw new Error(`${what} refers to unknown quest "${condition.questId}"`);
      }
    }
  }
}

function character(value: unknown, file: string): Character {
  if (!isRecord(value)) throw new Error(`${file}: "character" must be a mapping`);
  const hp = num(value, "hp", file);
  return {
    name: str(value, "name", file),
    pronouns: value.pronouns === undefined ? "they/them" : str(value, "pronouns", file),
    hp,
    maxHp: value.maxHp === undefined ? hp : num(value, "maxHp", file),
    level: value.level === undefined ? 1 : num(value, "level", file),
    xp: value.xp === undefined ? 0 : num(value, "xp", file),
    stats: numRecord(value.stats ?? {}, "stats", file),
    inventory: strList(value.inventory ?? [], "inventory", file),
  };
}

/** A roll made on first arriving somewhere, e.g. `{stat: wits, why: keep your nerve among the hanged men}`. */
/** The audio file `music` names, from the campaign directory; "none" (where `silence` is allowed) is null. */
async function music(data: Record<string, unknown>, dir: string, file: string, silence = true): Promise<string | null> {
  const value = str(data, "music", file);
  if (silence && value === "none") return null;
  const resolved = path.resolve(dir, value);
  await access(resolved).catch(() => {
    throw new Error(`${file}: music file "${value}" isn't there (it's looked for from ${dir})`);
  });
  return resolved;
}

function checkRequest(value: unknown, file: string, key = "arrival_check"): CheckRequest {
  if (!isRecord(value)) throw new Error(`${file}: "${key}" must be a mapping like {stat: wits, why: ...}`);
  return { stat: str(value, "stat", file), why: str(value, "why", file) };
}

/**
 * `hidden_items`: each either just the item's name, or
 *   {item, hidden (where/how), found (what the player notices), check: {stat, why}, needs (an item)}.
 */
function hiddenItems(value: unknown, file: string): HiddenItemDef[] {
  if (!Array.isArray(value)) throw new Error(`${file}: "hidden_items" must be a list`);
  return value.map((entry: unknown): HiddenItemDef => {
    if (typeof entry === "string" && entry.trim()) return { item: entry.trim() };
    if (!isRecord(entry)) throw new Error(`${file}: each hidden item must be a name or a mapping with "item"`);
    const optional = (key: string) => (entry[key] === undefined ? {} : { [key]: str(entry, key, file) });
    return {
      item: str(entry, "item", file),
      ...optional("hidden"),
      ...optional("found"),
      ...optional("needs"),
      ...(entry.check === undefined ? {} : { check: checkRequest(entry.check, file, "check") }),
    };
  });
}

/** `start_time: "20:00"`; morning if not given. */
function startTime(value: unknown, file: string): number {
  if (value === undefined) return 8 * 60;
  const minutes = typeof value === "string" ? parseClock(value) : undefined;
  if (minutes === undefined) throw new Error(`${file}: "start_time" must be a time like "20:00"`);
  return minutes;
}

function position(value: unknown, file: string): GridPosition {
  if (!isRecord(value)) throw new Error(`${file}: "map" must be a mapping like {x: 0, y: -1} (and z: -1 for a level below)`);
  return { x: num(value, "x", file), y: num(value, "y", file), z: value.z === undefined ? 0 : num(value, "z", file) };
}

function quests(value: unknown, file: string): QuestDef[] {
  if (!Array.isArray(value)) throw new Error(`${file}: "quests" must be a list`);
  return value.map((quest: unknown) => {
    if (!isRecord(quest)) throw new Error(`${file}: each quest must be a mapping`);
    const id = str(quest, "id", file);
    const where = `${file}, quest ${id}`;
    if (!Array.isArray(quest.done) || !quest.done.length) {
      throw new Error(`${where}: "done" must list the conditions that complete it`);
    }
    if (quest.starts !== undefined && !Array.isArray(quest.starts)) {
      throw new Error(`${where}: "starts" must list the conditions that start it`);
    }
    return {
      id,
      title: str(quest, "title", file),
      description: str(quest, "description", file),
      starts: ((quest.starts ?? []) as unknown[]).map((c) => condition(c, where)),
      done: quest.done.map((c: unknown) => condition(c, where)),
      reward: reward(quest.reward ?? {}, where),
    };
  });
}

/**
 * One condition of a quest's definition of done, written as a single-key mapping:
 *   have: <item>                      the player is carrying it
 *   gave: {item: <item>, to: <npc>}   the player has given it to that NPC
 *   at: <location>                    the player is there
 *   visited: <location>               the player has been there
 *   knows: <npc>                      the player has learned that NPC's name
 *   completed: <quest>                that quest is done (for quests that start after another)
 */
function condition(value: unknown, where: string): QuestCondition {
  const entries = isRecord(value) ? Object.entries(value) : [];
  if (entries.length !== 1) throw new Error(`${where}: each condition must have one key, like "have: iron key"`);
  const [[kind, arg]] = entries;
  const text = (v: unknown, key: string) => {
    if (typeof v !== "string" || !v.trim()) throw new Error(`${where}: "${key}" must be a non-empty string`);
    return v.trim();
  };
  switch (kind) {
    case "have":
      return { kind, item: text(arg, kind) };
    case "at":
    case "visited":
      return { kind, locationId: text(arg, kind) };
    case "knows":
      return { kind, npcId: text(arg, kind) };
    case "completed":
      return { kind, questId: text(arg, kind) };
    case "gave": {
      if (!isRecord(arg)) throw new Error(`${where}: "gave" must be a mapping like {item: iron key, to: marta}`);
      return { kind, item: text(arg.item, "gave.item"), npcId: text(arg.to, "gave.to") };
    }
    default:
      throw new Error(`${where}: unknown condition "${kind}" (have, gave, at, visited, knows, completed)`);
  }
}

function reward(value: unknown, where: string): Reward {
  if (!isRecord(value)) throw new Error(`${where}: "reward" must be a mapping like {xp: 100, items: [...]}`);
  return {
    xp: value.xp === undefined ? 0 : num(value, "xp", where),
    items: strList(value.items ?? [], "reward.items", where),
  };
}

function knowledge(value: unknown, file: string): KnowledgeDef[] {
  if (!Array.isArray(value)) throw new Error(`${file}: "knowledge" must be a list`);
  return value.map((item: unknown) => {
    if (!isRecord(item)) throw new Error(`${file}: each knowledge entry must be a mapping`);
    return {
      id: str(item, "id", file),
      fact: str(item, "fact", file),
      share: oneOf<ShareLevel>(item.share ?? "public", ["public", "trusted", "secret"], "share", file),
    };
  });
}

function oneOf<T extends string>(value: unknown, options: readonly T[], key: string, file: string): T {
  if (!options.includes(value as T)) throw new Error(`${file}: "${key}" must be one of ${options.join(", ")}`);
  return value as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(data: Record<string, unknown>, key: string, file: string): string {
  const value = data[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${file}: "${key}" must be a non-empty string`);
  return value.trim();
}

function num(data: Record<string, unknown>, key: string, file: string): number {
  const value = data[key];
  if (typeof value !== "number") throw new Error(`${file}: "${key}" must be a number`);
  return value;
}

function strList(value: unknown, key: string, file: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(`${file}: "${key}" must be a list of strings`);
  }
  return value;
}

function strRecord(value: unknown, key: string, file: string): Record<string, string> {
  if (!isRecord(value) || !Object.values(value).every((v) => typeof v === "string")) {
    throw new Error(`${file}: "${key}" must map names to strings`);
  }
  return value as Record<string, string>;
}

function numRecord(value: unknown, key: string, file: string): Record<string, number> {
  if (!isRecord(value) || !Object.values(value).every((v) => typeof v === "number")) {
    throw new Error(`${file}: "${key}" must map names to numbers`);
  }
  return value as Record<string, number>;
}
