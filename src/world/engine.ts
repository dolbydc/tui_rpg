import type {
  Character,
  CheckRequest,
  Clock,
  Conversation,
  GameState,
  Intent,
  LocationDef,
  MapView,
  NpcDef,
  NpcMovement,
  QuestCondition,
  Resolution,
  Resolved,
  SceneView,
  WorldDefinition,
  WorldEvent,
} from "../domain/types.js";
import { complicationFor, DRIVE_PER_QUEST, rollCheck, type Rng } from "./checks.js";
import { isAdjacent } from "./map.js";
import { QUICK_TURN_SECONDS, ROUTINE_STEP_SECONDS, secondsUntilWaking, timeAt, TURN_SECONDS } from "./time.js";

/** Actions the player gets each turn. NPCs move, and talk among themselves, between turns. */
export const ACTIONS_PER_TURN = 3;

/** Levelling up from level n costs n × XP_PER_LEVEL experience, raises one stat by 1 and max HP by HP_PER_LEVEL. */
export const XP_PER_LEVEL = 100;
export const HP_PER_LEVEL = 2;

export function levelUpCost(level: number): number {
  return level * XP_PER_LEVEL;
}

/**
 * Owns the rules and the campaign state. Everything here is deterministic: no LLM calls, so
 * what the player can actually do never depends on model output.
 */
export class WorldEngine {
  readonly world: WorldDefinition;
  /** The dice. */
  private readonly rng: Rng;

  constructor(world: WorldDefinition, rng: Rng = Math.random) {
    this.world = world;
    this.rng = rng;
  }

  /** A fresh campaign, played by the world's own character unless the player made one. */
  newGame(campaignId: string, character: Character = this.world.start.character): GameState {
    const { start, locations } = this.world;
    return {
      campaignId,
      worldId: this.world.id,
      turn: 1,
      elapsed: 0,
      actionsLeft: ACTIONS_PER_TURN,
      drive: DRIVE_PER_QUEST,
      locationId: start.locationId,
      visited: [start.locationId],
      character: structuredClone(character),
      quests: structuredClone(start.quests),
      locationItems: Object.fromEntries([...locations.values()].map((l) => [l.id, [...l.items]])),
      hiddenItems: hiddenAtStart(locations.values()),
      npcItems: {},
      knownNpcs: [],
      routineDelay: {},
      complications: [],
      locationNotes: {},
    };
  }

  scene(state: GameState): SceneView {
    const location = this.location(state.locationId);
    return {
      location,
      exits: Object.entries(location.exits).map(([direction, id]) => ({
        direction,
        name: this.location(id).name,
      })),
      npcs: this.npcsAt(location.id, state),
      others: [...this.world.npcs.values()].filter((npc) => this.npcLocation(npc, state) !== location.id),
      knownNpcs: state.knownNpcs,
      items: state.locationItems[location.id] ?? [],
      notes: state.locationNotes[location.id] ?? [],
      time: this.time(state),
      knownPlaces: state.visited.filter((id) => id !== location.id).map((id) => ({ id, name: this.location(id).name })),
      character: state.character,
      quests: state.quests,
    };
  }

  /** Where an NPC is: following their routine (a step every ROUTINE_STEP_SECONDS), held back while they paused. */
  npcLocation(npc: NpcDef, clock: Clock): string {
    if (!npc.routine) return npc.locationId;
    const step = 1 + Math.floor((clock.elapsed - (clock.routineDelay[npc.id] ?? 0)) / ROUTINE_STEP_SECONDS);
    const length = npc.routine.length;
    return npc.routine[((step % length) + length) % length];
  }

  npcsAt(locationId: string, clock: Clock): NpcDef[] {
    return [...this.world.npcs.values()].filter((npc) => this.npcLocation(npc, clock) === locationId);
  }

  /**
   * The state after a resolved action: its events applied, its cost spent and the conversation tracked.
   * When the last action is spent the turn ends (see endTurn).
   */
  act(state: GameState, intent: Intent, resolution: Resolved): GameState {
    let next: GameState = { ...this.apply(state, resolution.events) };
    next.conversation = conversationAfter(state, next, intent, resolution);
    if (intent.kind === "sleep") return this.sleep({ ...next, actionsLeft: 0 });
    if (resolution.events.some((e) => e.type === "checked" && e.check.npcId)) next.engaged = true;
    // Spend the cost, ending turns as the actions run out: a journey of several steps can run into the next.
    let cost = actionCost(intent, state, resolution);
    while (cost > 0) {
      const spent = Math.min(cost, next.actionsLeft);
      next = { ...next, actionsLeft: next.actionsLeft - spent };
      cost -= spent;
      if (next.actionsLeft === 0) next = this.endTurn(next);
    }
    return next;
  }

  /**
   * The way to a place the player has been, through places they've been: the locations along it, the
   * destination last. Undefined if they don't know a way (or are already there).
   */
  route(state: GameState, to: string): string[] | undefined {
    const known = new Set(state.visited);
    const previous = new Map<string, string>([[state.locationId, ""]]);
    const queue = [state.locationId];
    for (const at of queue) {
      if (at === to) break;
      for (const next of Object.values(this.location(at).exits)) {
        if (!known.has(next) || previous.has(next)) continue;
        previous.set(next, at);
        queue.push(next);
      }
    }
    if (to === state.locationId || !previous.has(to)) return undefined;
    const path = [to];
    while (previous.get(path[0]) !== state.locationId) path.unshift(previous.get(path[0])!);
    return path;
  }

  /**
   * The night passes: the player wakes at WAKE_AT, rested (full HP). Any conversation is over, and the
   * world moves on by however long the sleep took.
   */
  private sleep(state: GameState): GameState {
    const rested: GameState = {
      ...state,
      conversation: undefined,
      character: { ...state.character, hp: state.character.maxHp },
    };
    const woken = this.endTurn(rested);
    return { ...woken, elapsed: state.elapsed + secondsUntilWaking(state.elapsed, this.world.start.time) };
  }

  time(state: Pick<GameState, "elapsed">) {
    return timeAt(state.elapsed, this.world.start.time);
  }

  /**
   * Starts the next turn with a full set of actions. The turn took ten minutes, or six seconds if the player
   * spent it in conversation or confronting someone; NPC routines move on with the clock. An NPC still in
   * conversation with the player stays put: their routine pauses until the conversation ends.
   */
  endTurn(state: GameState): GameState {
    const seconds = state.conversation || state.engaged ? QUICK_TURN_SECONDS : TURN_SECONDS;
    const next: GameState = {
      ...state,
      turn: state.turn + 1,
      elapsed: state.elapsed + seconds,
      actionsLeft: ACTIONS_PER_TURN,
      engaged: undefined,
    };
    if (next.conversation) {
      const { npcId } = next.conversation;
      next.routineDelay = { ...next.routineDelay, [npcId]: (next.routineDelay[npcId] ?? 0) + seconds };
    }
    return next;
  }

  /** The visited places on the grid, with what the player knows of each. */
  mapView(state: GameState): MapView {
    // Only the level the player is on: going down to a cellar shows the cellar, not the street above.
    const level = this.location(state.locationId).position.z;
    const visited = new Set(state.visited.filter((id) => this.location(id).position.z === level));
    const cells = [...visited].map((id) => {
      const location = this.location(id);
      const here = id === state.locationId;
      const people = here
        ? this.npcsAt(id, state).map((npc) => (state.knownNpcs.includes(npc.id) ? initial(npc) : undefined))
        : [];
      const levels = Object.values(location.exits).map((target) => this.location(target).position.z);
      return {
        id,
        label: location.label,
        position: location.position,
        here,
        people,
        items: state.locationItems[id]?.length ?? 0,
        stairs: { up: levels.some((z) => z > level), down: levels.some((z) => z < level) },
      };
    });
    const links: MapView["links"] = [];
    for (const id of visited) {
      const from = this.location(id).position;
      for (const target of new Set(Object.values(this.location(id).exits))) {
        const to = this.location(target).position;
        // Each pair of visited places once; exits into the unknown always.
        if (!isAdjacent(from, to) || (visited.has(target) && target < id)) continue;
        links.push({ from, to });
      }
    }
    return { level, cells, links };
  }

  /**
   * Rolls for a resolved intent whose outcome is uncertain: one the interpreter flagged (deceiving,
   * fighting, sneaking…), or arriving somewhere for the first time that calls for one (keeping your
   * nerve…). Pushing it spends a drive, if there's any left, for an extra die. A partial success also sets
   * up its hidden complication.
   */
  check(intent: Intent, resolution: Resolved, state: GameState, input: string): WorldEvent[] {
    const arrival = resolution.events.find((e) => e.type === "moved");
    const destination = arrival?.type === "moved" ? this.location(arrival.to) : undefined;
    const firstVisit = destination && !state.visited.includes(destination.id) ? destination.enterCheck : undefined;
    // A search's roll is the hidden item's own, whatever the interpreter thought it needed.
    const request: CheckRequest | undefined = resolution.search?.check ?? intent.check ?? firstVisit;
    if (!request) return [];
    const { stats } = state.character;
    const stat = findMatch(Object.keys(stats), request.stat, (s) => [s]);
    if (!stat) return [];
    const target =
      resolution.npc ??
      (request.target ? findMatch(this.scene(state).npcs, request.target, (n) => npcKeys(n, state)) : undefined);
    const pushed = Boolean(request.push) && state.drive > 0;
    const rolled = rollCheck(this.rng, stat, stats[stat], request.why, { npcId: target?.id, pushed });
    const result = request.stealth ? { ...rolled, stealth: true } : rolled;
    const events: WorldEvent[] = [{ type: "checked", check: result }];
    if (resolution.search && (result.outcome === "success" || result.outcome === "partial_success")) {
      events.push(...resolution.search.items.map((h): WorldEvent => ({ type: "item_found", item: h.item, locationId: state.locationId })));
    }
    if (result.outcome === "partial_success") {
      const where = destination?.id ?? state.locationId;
      events.push({ type: "complication_pending", complication: complicationFor(this.rng, result, state, input, where) });
    }
    return events;
  }

  /** Quests not yet started whose start conditions now hold: each one restores the player's drive. */
  questStarts(state: GameState): WorldEvent[] {
    return state.quests.flatMap((quest): WorldEvent[] => {
      const def = this.world.quests.get(quest.id);
      if (quest.status !== "pending" || !def?.starts.every((c) => this.holds(c, state))) return [];
      return [{ type: "quest_started", questId: quest.id }];
    });
  }

  /** Active quests whose definition of done now holds, as completion events that pay out their rewards. */
  questCompletions(state: GameState): WorldEvent[] {
    return state.quests.flatMap((quest): WorldEvent[] => {
      const def = this.world.quests.get(quest.id);
      if (quest.status !== "active" || !def?.done.every((c) => this.holds(c, state))) return [];
      return [{ type: "quest_completed", questId: quest.id, reward: structuredClone(def.reward) }];
    });
  }

  holds(condition: QuestCondition, state: GameState): boolean {
    switch (condition.kind) {
      case "have":
        return state.character.inventory.some((stack) => sameItem(takeOne(stack).given, condition.item));
      case "gave":
        return (state.npcItems[condition.npcId] ?? []).some((item) => sameItem(item, condition.item));
      case "at":
        return state.locationId === condition.locationId;
      case "visited":
        return state.visited.includes(condition.locationId);
      case "knows":
        return state.knownNpcs.includes(condition.npcId);
      case "completed":
        return state.quests.some((q) => q.id === condition.questId && q.status === "completed");
    }
  }

  /** Spends experience on the next level, raising `stat`. Costs no action. */
  levelUp(state: GameState, stat: string): Resolution {
    const { character } = state;
    const name = findMatch(Object.keys(character.stats), stat, (s) => [s]);
    if (!name) return { ok: false, reason: `No stat called "${stat}". Choose one of: ${Object.keys(character.stats).join(", ")}.` };
    const cost = levelUpCost(character.level);
    if (character.xp < cost) {
      return { ok: false, reason: `Level ${character.level + 1} needs ${cost} XP; you have ${character.xp}.` };
    }
    return { ok: true, events: [{ type: "levelled_up", stat: name, cost }] };
  }

  /** NPCs whose routine took them into or out of the player's sight between two states. */
  npcMovements(before: GameState, after: GameState): NpcMovement[] {
    const here = after.locationId;
    const playerMoved = before.locationId !== here;
    const movements: NpcMovement[] = [];
    for (const npc of this.world.npcs.values()) {
      const from = this.npcLocation(npc, before);
      const to = this.npcLocation(npc, after);
      if (from === to) continue;
      if (to === here) {
        movements.push({ npc, from, to, kind: playerMoved && from === before.locationId ? "followed" : "arrived" });
      } else if (from === here && !playerMoved) {
        movements.push({ npc, from, to, kind: "left" });
      }
    }
    return movements;
  }

  /** NPCs named in what the player heard and didn't know yet. Only spoken words count, not *actions*. */
  namesHeard(heard: string[], state: GameState): NpcDef[] {
    const speech = heard.map(spoken).join(" ");
    return [...this.world.npcs.values()].filter(
      (npc) => !state.knownNpcs.includes(npc.id) && nameForms(npc).some((form) => wordIn(speech, form)),
    );
  }

  npc(id: string): NpcDef {
    const npc = this.world.npcs.get(id);
    if (!npc) throw new Error(`Unknown NPC "${id}"`);
    return npc;
  }

  /** Decides whether an intent is possible and what state changes it causes. */
  resolve(intent: Intent, state: GameState): Resolution {
    const scene = this.scene(state);
    switch (intent.kind) {
      case "search": {
        // What's still hidden here and can be found at all (some need the right thing in hand), narrowed to
        // what matches where the player looks; a search of nothing in particular covers the whole place.
        const remaining = state.hiddenItems[state.locationId] ?? [];
        const findable = scene.location.hiddenItems.filter(
          (h) => remaining.includes(h.item) && (!h.needs || this.holds({ kind: "have", item: h.needs }, state)),
        );
        const aimed = intent.where ? findable.filter((h) => sharesWord(intent.where!, `${h.item} ${h.hidden ?? ""}`)) : [];
        const candidates = aimed.length ? aimed : findable;
        const easy = candidates.filter((h) => !h.check);
        const hard = candidates.filter((h) => h.check);
        return {
          ok: true,
          events: easy.map((h): WorldEvent => ({ type: "item_found", item: h.item, locationId: state.locationId })),
          ...(hard.length ? { search: { items: hard, check: hard[0].check! } } : {}),
        };
      }
      case "look":
      case "wait":
      case "sleep":
      case "act":
        return { ok: true, events: [] };
      case "move": {
        // Models sometimes echo an exit as the scene lists it, "out (Brackenford Square)": try each part.
        const parts = [intent.direction, ...intent.direction.split(/[()]/)].map((p) => p.trim()).filter(Boolean);
        const exit = parts
          .map((part) => findMatch(scene.exits, part, (e) => [e.direction, e.name]))
          .find((match) => match !== undefined);
        if (exit) {
          return { ok: true, events: [{ type: "moved", from: state.locationId, to: scene.location.exits[exit.direction] }] };
        }
        // Not an exit from here: somewhere they've been, reached along the paths they know, a step per action.
        const known = state.visited.map((id) => this.location(id));
        const place = parts
          .map((part) => findMatch(known, part, (l) => [l.name, l.label, l.id]))
          .find((match) => match !== undefined);
        if (place?.id === state.locationId) return { ok: false, reason: `You're already at ${place.name}.` };
        const path = place && this.route(state, place.id);
        if (!path) return { ok: false, reason: `You can't go "${intent.direction}" from here.` };
        return {
          ok: true,
          events: path.map((to, i): WorldEvent => ({ type: "moved", from: i ? path[i - 1] : state.locationId, to })),
        };
      }
      case "take": {
        // One thing per action: the first of those asked for that's here. The player is told what's left.
        const found = intent.items.map((wanted) => findMatch(scene.items, wanted, (i) => [i]));
        const index = found.findIndex((i) => i !== undefined);
        if (index < 0) return { ok: false, reason: `There is no "${intent.items[0]}" here.` };
        const item = found[index]!;
        const left = [...new Set(found.filter((i): i is string => i !== undefined && i !== item))];
        const notes = intent.items.length > 1 ? [onlyOne(left)] : [];
        return {
          ok: true,
          // From a counted pile ("12 crates"), "a crate" takes one and "the crates" takes the lot.
          events: [{ type: "item_taken", item: portion(item, intent.items[index]), locationId: state.locationId }],
          ...(notes.length ? { notes } : {}),
        };
      }
      case "talk": {
        const npc = findPerson(scene.npcs, intent.npc, state);
        if (!npc) return { ok: false, reason: `There's nobody called "${intent.npc}" here.` };
        return { ok: true, events: [], npc };
      }
      case "give": {
        const npc = findPerson(scene.npcs, intent.npc, state);
        if (!npc) return { ok: false, reason: `There's nobody called "${intent.npc}" here.` };
        const stack = findMatch(state.character.inventory, singular(intent.item), (i) => [i, singular(i)]);
        if (!stack) return { ok: false, reason: `You don't have "${intent.item}".` };
        return { ok: true, events: [{ type: "item_given", item: takeOne(stack).given, npcId: npc.id }], npc };
      }
      case "drop": {
        const stack = findMatch(state.character.inventory, singular(intent.item), (i) => [i, singular(i)]);
        if (!stack) return { ok: false, reason: `You don't have "${intent.item}".` };
        return { ok: true, events: [{ type: "item_dropped", item: portion(stack, intent.item), locationId: state.locationId }] };
      }
    }
  }

  /** Returns the state after the events; never mutates the input. */
  apply(state: GameState, events: WorldEvent[]): GameState {
    const next = structuredClone(state);
    for (const event of events) {
      switch (event.type) {
        case "moved":
          next.locationId = event.to;
          if (!next.visited.includes(event.to)) next.visited.push(event.to);
          break;
        case "item_taken":
          next.locationItems[event.locationId] = removeFrom(next.locationItems[event.locationId] ?? [], event.item);
          next.character.inventory = addTo(next.character.inventory, event.item);
          break;
        case "item_dropped":
          next.character.inventory = removeFrom(next.character.inventory, event.item);
          next.locationItems[event.locationId] = addTo(next.locationItems[event.locationId] ?? [], event.item);
          break;
        case "item_found":
          next.hiddenItems[event.locationId] = (next.hiddenItems[event.locationId] ?? []).filter((i) => i !== event.item);
          next.locationItems[event.locationId] = [...(next.locationItems[event.locationId] ?? []), event.item];
          break;
        case "item_given": {
          next.character.inventory = removeFrom(next.character.inventory, event.item);
          next.npcItems[event.npcId] = [...(next.npcItems[event.npcId] ?? []), event.item];
          break;
        }
        case "quest_completed": {
          const quest = next.quests.find((q) => q.id === event.questId);
          if (quest) quest.status = "completed";
          next.character.xp += event.reward.xp;
          for (const item of event.reward.items) next.character.inventory = addTo(next.character.inventory, item);
          break;
        }
        case "checked":
          if (event.check.pushed) next.drive -= 1;
          break;
        case "quest_started": {
          const quest = next.quests.find((q) => q.id === event.questId);
          if (quest) quest.status = "active";
          next.drive = DRIVE_PER_QUEST;
          break;
        }
        case "complication_pending":
          next.complications.push(event.complication);
          break;
        case "complication_resolved":
          next.complications = next.complications.filter((c) => c.id !== event.id);
          if (event.locationId && event.note) {
            next.locationNotes[event.locationId] = [...(next.locationNotes[event.locationId] ?? []), event.note];
          }
          break;
        case "levelled_up": {
          const { character } = next;
          character.xp -= event.cost;
          character.level += 1;
          character.stats[event.stat] = (character.stats[event.stat] ?? 0) + 1;
          character.maxHp += HP_PER_LEVEL;
          character.hp += HP_PER_LEVEL;
          break;
        }
      }
    }
    return next;
  }

  location(id: string): LocationDef {
    const location = this.world.locations.get(id);
    if (!location) throw new Error(`Unknown location "${id}"`);
    return location;
  }
}

/** Exact (case-insensitive, ignoring a leading article) match first, then substring. */
export function findMatch<T>(candidates: readonly T[], query: string, keys: (c: T) => string[]): T | undefined {
  const q = normalize(query);
  if (!q) return undefined;
  return (
    candidates.find((c) => keys(c).some((k) => normalize(k) === q)) ??
    candidates.find((c) => keys(c).some((k) => normalize(k).includes(q)))
  );
}

/** Lower case, without a leading article, and a hyphen is a space ("the Lantern-Key" = "lantern key"). */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[-\s]+/g, " ").replace(/^(the|a|an)\s+/, "");
}

/**
 * Splits one item off an inventory entry. A counted stack ("3 copper coins") gives one ("copper coin")
 * and keeps the rest ("2 copper coins"); anything else is given whole.
 */
export function takeOne(stack: string): { given: string; remaining?: string } {
  const match = /^(\d+)\s+(.+)$/.exec(stack);
  if (!match || Number(match[1]) < 2) return { given: stack.replace(/^1\s+/, "") };
  const count = Number(match[1]) - 1;
  const one = singular(match[2]);
  return { given: one, remaining: count === 1 ? `1 ${one}` : `${count} ${match[2]}` };
}

/** "copper coin" → "a copper coin", "iron key" → "an iron key"; names that already have one are kept. */
export function withArticle(item: string): string {
  if (/^(a|an|the|some|\d+)\s/i.test(item)) return item;
  return `${/^[aeiou]/i.test(item) ? "an" : "a"} ${item}`;
}

/** An item name without its article: "an iron key" → "iron key". */
export function bareItem(item: string): string {
  return item.trim().replace(/^(a|an|the|some)\s+/i, "");
}

/** Whether two item names mean the same thing, ignoring case, articles and plurals ("an iron key" = "Iron keys"). */
function sameItem(a: string, b: string): boolean {
  return normalize(singular(a)) === normalize(singular(b));
}

/** Naive singular for item names: "copper coins" → "copper coin", "boxes" → "box"; drops a leading article or count of one. */
function singular(name: string): string {
  return name
    .trim()
    .replace(/^(a|an|one|1)\s+/i, "")
    .replace(/([^aeiou])ies$/i, "$1y")
    .replace(/(x|ch|sh|ss)es$/i, "$1")
    .replace(/(?<!s)s$/, "");
}

/** Naive plural, the reverse of singular: "crate" → "crates", "box" → "boxes". */
function plural(name: string): string {
  if (/(s|x|ch|sh)$/i.test(name)) return `${name}es`;
  if (/[^aeiou]y$/i.test(name)) return `${name.slice(0, -1)}ies`;
  return `${name}s`;
}

/** How many of what a list entry is: "12 crates" → 12 × "crate"; anything else is one of itself. */
function pile(stack: string): { count: number; one: string } {
  const match = /^(\d+)\s+(.+)$/.exec(stack.trim());
  return match ? { count: Number(match[1]), one: singular(match[2]) } : { count: 1, one: stack.trim() };
}

/**
 * What the player gets from a stack: one off a counted pile if they asked for one ("a crate", "crate"),
 * the whole stack if they asked for several ("the crates") or it isn't a pile.
 */
function portion(stack: string, asked: string): string {
  const one = /^(a|an|one|1)\s/i.test(asked.trim()) || singular(asked) === asked.trim().replace(/^the\s+/i, "");
  return one ? takeOne(stack).given : stack;
}

/** Adds an item to a list, merging it into a pile of the same thing: "crate" + "2 crates" → "3 crates". */
export function addTo(list: string[], item: string): string[] {
  const adding = pile(item);
  const index = list.findIndex((stack) => sameItem(pile(stack).one, adding.one));
  if (index < 0) return [...list, item];
  const count = pile(list[index]).count + adding.count;
  const name = bareItem(adding.one);
  return list.map((stack, i) => (i === index ? `${count} ${plural(name)}` : stack));
}

/** Takes an item out of a list: a whole entry, or that many off a pile ("crate" from "3 crates" leaves "2 crates"). */
export function removeFrom(list: string[], item: string): string[] {
  const exact = list.indexOf(item);
  if (exact >= 0) return list.filter((_, i) => i !== exact);
  const taking = pile(item);
  const index = list.findIndex((stack) => sameItem(pile(stack).one, taking.one));
  if (index < 0) return list;
  const left = pile(list[index]).count - taking.count;
  const name = bareItem(pile(list[index]).one);
  if (left <= 0) return list.filter((_, i) => i !== index);
  return list.map((stack, i) => (i === index ? (left === 1 ? `1 ${name}` : `${left} ${plural(name)}`) : stack));
}

/**
 * What an action costs: looking around is free, waiting spends whatever is left of the turn, and
 * everything else (moving, talking, taking, giving, attacking, searching…) costs one action.
 */
export function actionCost(intent: Intent, state: Pick<GameState, "actionsLeft">, resolution?: Resolved): number {
  if (intent.kind === "look") return 0;
  if (intent.kind === "wait" || intent.kind === "sleep") return state.actionsLeft;
  // A journey along known paths: one action per step.
  if (intent.kind === "move" && resolution) return Math.max(1, resolution.events.filter((e) => e.type === "moved").length);
  return 1;
}

/** Actions the player may spend not addressing an NPC (sitting down, looking around) before the conversation ends. */
export const CONVERSATION_GRACE = 1;

/**
 * Talking to or giving something to an NPC starts or continues a conversation with them. It ends when
 * the player leaves, or spends more than CONVERSATION_GRACE actions without addressing them.
 */
function conversationAfter(
  before: GameState,
  after: GameState,
  intent: Intent,
  resolution: Resolved,
): Conversation | undefined {
  if ((intent.kind === "talk" || intent.kind === "give") && resolution.npc) {
    return { npcId: resolution.npc.id, idleActions: 0 };
  }
  const current = before.conversation;
  if (!current || after.locationId !== before.locationId || current.idleActions >= CONVERSATION_GRACE) return undefined;
  return { npcId: current.npcId, idleActions: current.idleActions + 1 };
}

/** Told when the player tries to pick up several things at once. */
function onlyOne(left: string[]): string {
  const still = left.map((i, n) => `${n ? "the" : "The"} ${bareItem(i)}`);
  const rest = still.length ? ` ${still.join(" and ")} ${still.length > 1 ? "are" : "is"} still here.` : "";
  return `(You can only pick up one thing at a time.${rest})`;
}

/**
 * Who the player means, among the people here. Models paraphrase ("the barwoman" for "a woman keeping the
 * bar"), so past an exact or partial match: the one person sharing a word with the query, else whoever the
 * player is mid-conversation with. Someone named who isn't here is never mistaken for whoever is.
 */
function findPerson(people: NpcDef[], query: string, state: GameState): NpcDef | undefined {
  const exact = findMatch(people, query, (n) => npcKeys(n, state));
  if (exact) return exact;
  const sharing = people.filter((n) => npcKeys(n, state).some((key) => sharesWord(query, key)));
  if (sharing.length === 1) return sharing[0];
  return people.find((n) => n.id === state.conversation?.npcId);
}

/** Whether two texts share a word of four letters or more, either inside the other ("barwoman" ~ "woman"). */
function sharesWord(a: string, b: string): boolean {
  const words = (text: string) => text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const theirs = words(b);
  return words(a).some((w) => theirs.some((t) => t.includes(w) || w.includes(t)));
}

/** Every location's hidden items, none found yet. */
export function hiddenAtStart(locations: Iterable<LocationDef>): Record<string, string[]> {
  return Object.fromEntries([...locations].map((l) => [l.id, l.hiddenItems.map((h) => h.item)]));
}

/** What the player can call an NPC: how they look, and their name once they know it. */
function npcKeys(npc: NpcDef, state: GameState): string[] {
  const keys = [npc.epithet, npc.appearance];
  return state.knownNpcs.includes(npc.id) ? [npc.name, npc.id, ...keys] : keys;
}

/** The letter that marks a known NPC on the map: the first of their name, past any title ("P" for Old Pell). */
function initial(npc: NpcDef): string {
  return (nameForms(npc)[1] ?? npc.name).charAt(0).toUpperCase();
}

/** Titles that don't identify anyone on their own ("Old" in "Old Pell"). */
// Titles aren't names: hearing "the administrator" mustn't introduce Administrator Hask.
const HONORIFICS = new Set([
  "old", "young", "mister", "mistress", "master", "lady", "lord", "sir", "dame", "mother", "father", "granny", "uncle", "aunt",
  "brother", "sister", "doctor", "captain", "commander", "administrator", "director", "officer", "foreman", "chief",
]);

/** The ways someone might say an NPC's name: in full, or any distinctive part of it. Longest first. */
export function nameForms(npc: NpcDef): string[] {
  const parts = npc.name.split(/\s+/).filter((part) => part.length >= 3 && !HONORIFICS.has(part.toLowerCase()));
  return [npc.name, ...parts.filter((part) => part !== npc.name)];
}

/** Dialogue with any *action* text removed, leaving only what was said aloud. */
export function spoken(text: string): string {
  return text.replace(/\*[^*]*\*/g, " ");
}

export function wordIn(text: string, word: string): boolean {
  return new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
