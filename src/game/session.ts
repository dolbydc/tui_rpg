import type {
  Character,
  GameState,
  Intent,
  LocationDef,
  LogLine,
  MapView,
  NpcMemory,
  SceneView,
  TimeOfDay,
  TurnRecord,
  WorldEvent,
} from "../domain/types.js";
import {
  describeMovements,
  describeOutcome,
  describeRewards,
  describeScene,
  npcLabel,
  presentToPlayer,
} from "../narrative/describe.js";
import type { NarrativeEngine } from "../narrative/engine.js";
import type { CampaignStore } from "../storage/store.js";
import { ACTIONS_PER_TURN, findMatch, hiddenAtStart, levelUpCost, type WorldEngine } from "../world/engine.js";
import { DRIVE_PER_QUEST, dueHere, dueRealisations } from "../world/checks.js";
import { TURN_SECONDS } from "../world/time.js";
import { knowsPlayerName, memoriesOf, newMemory, recall } from "../world/memory.js";
import { observe } from "../world/perception.js";
import { applyExchange, findExchange } from "../world/sharing.js";
import { HELP, parseCommand } from "./commands.js";
import { advanceCreation, startCreation, type Creation } from "./creation.js";

export interface SessionDeps {
  world: WorldEngine;
  narrative: NarrativeEngine;
  store: CampaignStore;
  campaignId: string;
}

export interface TurnResult {
  /** Output for this turn (the player's own input is not echoed back). */
  lines: LogLine[];
  /** The campaign restarted; the UI should replace its log with these lines. */
  reset?: boolean;
  /** Back to the start menu (/new, or giving up on a character before there's a game to go back to). */
  menu?: boolean;
  quit?: boolean;
  /** Turn reading aloud on or off (undefined: toggle). Set by /voice; the UI owns the speaker. */
  voice?: { on?: boolean };
  /** Turn the music on or off (undefined: toggle). Set by /music. */
  music?: { on?: boolean };
}

/** Where the player is in the turn, and how far from the next level, for the character sheet. */
export interface PlayerStatus {
  turn: number;
  actionsLeft: number;
  actionsPerTurn: number;
  /** Experience the next level costs. */
  nextLevelXp: number;
  drive: number;
  drivePerQuest: number;
  time: TimeOfDay;
}

const RECENT_LINES = 12;

/** Orchestrates a play session: commands, the turn pipeline, and save/load. The UI only talks to this. */
export class SessionController {
  private readonly deps: SessionDeps;
  /** Undefined until a game is resumed or begun: while the first character is being made, say. */
  private state?: GameState;
  private recent: LogLine[] = [];
  /** Every NPC's memories for this campaign, oldest first. */
  private memories: NpcMemory[] = [];
  /** Set while the player is making a character for a new game (after /new). */
  private creation?: Creation;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  /** Whether start() resumed a saved campaign (whose history shouldn't be read aloud again). */
  resumed = false;

  get title(): string {
    return this.deps.world.world.title;
  }

  private get game(): GameState {
    if (!this.state) throw new Error("No game in progress");
    return this.state;
  }

  /** Whether there's a game in progress (not just a character being made for the first one). */
  get playing(): boolean {
    return this.state !== undefined;
  }

  get scene(): SceneView {
    return this.deps.world.scene(this.game);
  }

  /** The mood music where the player is (the location's own, or the world's); undefined for silence. */
  get music(): string | undefined {
    const { world } = this.deps.world;
    const here = this.state && world.locations.get(this.state.locationId);
    return (here?.music === undefined ? world.music : here.music) ?? undefined;
  }

  get map(): MapView {
    return this.deps.world.mapView(this.game);
  }

  get status(): PlayerStatus {
    const state = this.game;
    return {
      turn: state.turn,
      actionsLeft: state.actionsLeft,
      actionsPerTurn: ACTIONS_PER_TURN,
      nextLevelXp: levelUpCost(state.character.level),
      drive: state.drive,
      drivePerQuest: DRIVE_PER_QUEST,
      time: this.deps.world.time(state),
    };
  }

  /** Resumes the saved campaign, or starts a new one with the campaign's own character. */
  async start(): Promise<LogLine[]> {
    return (await this.resume()) ?? this.begin();
  }

  /** Makes a character for a new game of this campaign: the lines to show, then each answer goes to submit(). */
  newCharacter(): LogLine[] {
    const { creation, lines } = startCreation();
    this.creation = creation;
    return lines;
  }

  /**
   * Loads the saved game, if there is one, and returns the lines to show first (its recent history).
   * Everything is saved as it happens, so this is also how to come back to it from the menu.
   */
  async resume(): Promise<LogLine[] | undefined> {
    this.creation = undefined;
    const saved = await this.deps.store.load(this.deps.campaignId);
    if (!saved) return undefined;
    // Older saves predate pronouns, gifts, learning names, paused routines, the map, actions, levels,
    // rolls and newer stats.
    const { state } = saved;
    const template = this.deps.world.world.start.character;
    this.state = {
      ...state,
      actionsLeft: state.actionsLeft ?? ACTIONS_PER_TURN,
      // Saves from before the clock: every turn took ten minutes, and pauses were counted in turns.
      elapsed: state.elapsed ?? (state.turn - 1) * TURN_SECONDS,
      drive: state.drive ?? DRIVE_PER_QUEST,
      visited: state.visited ?? [state.locationId],
      conversation: state.actionsLeft === undefined ? undefined : state.conversation,
      character: {
        ...state.character,
        pronouns: state.character.pronouns ?? this.deps.world.world.start.character.pronouns,
        level: state.character.level ?? 1,
        xp: state.character.xp ?? 0,
        stats: { ...template.stats, ...state.character.stats },
      },
      complications: state.complications ?? [],
      ...placesSince(state, this.deps.world.world.locations.values()),
      locationNotes: state.locationNotes ?? {},
      npcItems: state.npcItems ?? {},
      knownNpcs: state.knownNpcs ?? [],
      routineDelay:
        state.elapsed === undefined
          ? Object.fromEntries(Object.entries(state.routineDelay ?? {}).map(([id, turns]) => [id, turns * TURN_SECONDS]))
          : state.routineDelay,
      // Quests added to the campaign since the save was made.
      quests: [
        ...state.quests,
        ...this.deps.world.world.start.quests.filter((q) => !state.quests.some((saved) => saved.id === q.id)),
      ],
    };
    this.memories = saved.memories;
    this.resumed = true;
    const replayed = saved.recent.flatMap(replay);
    this.keepRecent(replayed);
    return [...replayed, { kind: "system", text: `Resumed at turn ${this.state.turn}. Type /help for commands.` }];
  }

  async submit(raw: string): Promise<TurnResult> {
    const input = raw.trim();
    if (!input) return { lines: [] };

    const command = parseCommand(input);
    if (this.creation) return this.create(input, command?.kind);
    if (!this.state) return { lines: [], menu: true };
    switch (command?.kind) {
      case "help":
        return { lines: [{ kind: "system", text: HELP }] };
      case "quit":
        return { lines: [], quit: true };
      case "invalid":
        return { lines: [{ kind: "system", text: command.message }] };
      case "memories":
        return { lines: this.recall(command.npc) };
      case "levelup":
        return { lines: await this.levelUp(command.stat) };
      case "new":
        return { lines: [], menu: true };
      case "cancel":
        return { lines: [{ kind: "system", text: "Nothing to cancel." }] };
      case "voice":
        return { lines: [], voice: { on: command.on } };
      case "music":
        return { lines: [], music: { on: command.on } };
    }

    try {
      if (command?.kind === "push") return { lines: await this.playTurn(command.text, undefined, true) };
      return { lines: await this.playTurn(input, command?.intent) };
    } catch (err) {
      return { lines: [{ kind: "error", text: `Turn failed: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  }

  /**
   * One player action:
   * interpret → resolve → apply → narrate → learn names → observe → NPC exchange → present → persist.
   * Each action spends from the turn's allowance; when it runs out the turn ends, NPCs move on and may talk
   * among themselves. The world engine alone decides what changes and who knows what; the LLM only words
   * it and picks among allowed options. Nothing is kept unless the whole action succeeds.
   */
  private async playTurn(input: string, commandIntent: Intent | undefined, push = false): Promise<LogLine[]> {
    const { world, narrative, store } = this.deps;
    const state = this.game;

    // 1. Interpret: explicit commands skip the LLM. Mid-conversation, unaddressed lines go to the partner.
    //    /push marks the attempt as pushed, if it turns out to need a roll at all.
    const current = this.scene;
    const partner = current.npcs.find((n) => n.id === state.conversation?.npcId);
    const interpreted = commandIntent ?? (await narrative.interpret(input, current, partner));
    const intent: Intent =
      push && interpreted.check ? { ...interpreted, check: { ...interpreted.check, push: true } } : interpreted;
    const drive = driveNote(push || Boolean(intent.check?.push), intent, state.drive);

    // 2. Resolve against the rules. An impossible intent costs no action and leaves no record.
    const resolution = world.resolve(intent, state);
    if (!resolution.ok) return [{ kind: "system", text: resolution.reason }];

    // 2b. Roll: a risky attempt, or arriving somewhere that calls for it, is checked against a stat. Only the
    //     narrator learns how it went; the player sees the story, never the dice.
    const resolved = { ...resolution, events: [...resolution.events, ...world.check(intent, resolution, state, input)] };

    // 3. Apply state changes and spend the action, ending the turn if it was the last. An NPC the player is
    //    talking with holds their routine.
    let next = world.act(state, intent, resolved);
    const turnEnded = next.turn !== state.turn;

    // 3b. Quests: any whose definition of done now holds are completed and pay out their rewards; then any
    //     that can now start (perhaps because another finished) begin, restoring drive.
    const completed = world.questCompletions(next);
    next = world.apply(next, completed);
    const started = world.questStarts(next);
    next = world.apply(next, started);
    const completions = [...completed, ...started];
    const scene = world.scene(next);

    // 4. Narrate. Plain commands (other than talking) get deterministic text.
    const { npc } = resolution;
    const narrated =
      commandIntent && intent.kind !== "talk"
        ? describeOutcome(intent, resolved, scene)
        : await narrative.narrate({
            input,
            intent,
            resolution: { ...resolved, events: [...resolved.events, ...completions] },
            scene,
            recent: this.recent,
            memories: npc && recall(npc.id, this.memories),
            player: npc && {
              name: knowsPlayerName(npc.id, this.memories) ? state.character.name : undefined,
              given: state.npcItems[npc.id] ?? [],
              knowsYourName: state.knownNpcs.includes(npc.id),
            },
          });

    // 5. Learn names: anyone named aloud in what the player just heard is now known to them.
    const reply = narrated.find((line) => line.kind === "npc")?.text;
    const named = world.namesHeard(reply ? [reply] : [], next);
    if (named.length) next = { ...next, knownNpcs: [...next.knownNpcs, ...named.map((n) => n.id)] };
    const learned: LogLine[] = named.map((n) => ({ kind: "system", text: `(You now know ${n.epithet} as ${n.name}.)` }));

    // 6. Observe: NPCs who were there remember what they noticed, depending on their perception.
    const witnessed = observe(world, {
      before: state,
      after: next,
      intent,
      events: resolution.events,
      input,
      dialogue: npc && intent.kind === "talk" && reply ? { npc, said: intent.message, reply } : undefined,
      known: this.memories,
    });

    // 7. NPC exchange: between turns, NPCs who meet may pass on what they know.
    const exchanged = turnEnded
      ? await this.exchange(next, [...this.memories, ...witnessed])
      : { memories: [], lines: [] };

    // 7b. Complications: partial successes catch up with the player. Someone who was fooled sees through it
    //     as a turn ends; anything else goes wrong when the player is next at the place.
    const surfacing = await this.complications(next, turnEnded);
    next = world.apply(next, surfacing.events);
    const events = [...resolved.events, ...completions, ...surfacing.events];
    const formed = [...witnessed, ...exchanged.memories, ...surfacing.memories];

    // 8. Present: NPCs whose routines bring them into or out of view are announced, so nobody appears from
    //    nowhere, and everyone is shown as the player knows them.
    const movements = describeMovements(world.npcMovements(state, next), (id) => world.location(id), next.knownNpcs);
    const pushed = resolved.events.some((e) => e.type === "checked" && e.check.pushed);
    const lines = [
      ...(drive ? [drive] : []),
      ...(pushed ? [{ kind: "system" as const, text: `(You push yourself. Drive left: ${next.drive}.)` }] : []),
      ...presentToPlayer(
        [...narrated, ...surfacing.lines, ...movements, ...exchanged.lines],
        [...world.world.npcs.values()],
        next.knownNpcs,
      ),
      ...(resolution.notes ?? []).map((text): LogLine => ({ kind: "system", text })),
      ...learned,
      ...describeRewards(completions, next.quests, next.character, levelUpCost(next.character.level)),
      ...(turnEnded ? [{ kind: "system" as const, text: `— Turn ${next.turn} —` }] : []),
    ];

    // 9. Persist the new state, its turn record and new memories together.
    await store.commitTurn(next, { turn: next.turn, input, intent, events, output: lines }, formed);
    this.state = next;
    this.memories.push(...formed);
    this.keepRecent([{ kind: "player", text: input }, ...lines]);
    return lines;
  }

  /** Complications of earlier partial successes that are due now: see step 7b. */
  private async complications(
    state: GameState,
    turnEnded: boolean,
  ): Promise<{ events: WorldEvent[]; memories: NpcMemory[]; lines: LogLine[] }> {
    const { world, narrative } = this.deps;
    const events: WorldEvent[] = [];
    const memories: NpcMemory[] = [];
    const lines: LogLine[] = [];
    for (const due of turnEnded ? dueRealisations(state) : []) {
      const npc = world.npc(due.npcId!);
      const text = `Realised the stranger got the better of them: when the stranger tried to ${due.why}, ${npc.name} went along with it, but now sees it for what it was.`;
      memories.push(newMemory(npc, { turn: state.turn, kind: "witnessed", about: "player", text }));
      events.push({ type: "complication_resolved", id: due.id });
    }
    const here = dueHere(state);
    if (here) {
      try {
        const surfaced = await narrative.surface(here, world.scene(state), this.recent);
        if (surfaced) {
          events.push({ type: "complication_resolved", id: here.id, locationId: here.locationId, note: surfaced.lasting });
          lines.push({ kind: "narration", text: surfaced.narration });
        }
      } catch {
        // It keeps; it will surface another time the player is here.
      }
    }
    return { events, memories, lines };
  }

  /** The next step of making a character; when it's done, the old campaign is replaced by a new one. */
  private async create(input: string, command: string | undefined): Promise<TurnResult> {
    if (command === "quit") return { lines: [], quit: true };
    if (command === "cancel") {
      this.creation = undefined;
      return this.state ? { lines: [{ kind: "system", text: "Back to your game." }] } : { lines: [], menu: true };
    }
    if (command === "new") {
      this.creation = undefined;
      return { lines: [], menu: true };
    }
    if (command) return { lines: [{ kind: "system", text: "Finish making your character first, or /cancel." }] };
    const step = advanceCreation(this.creation!, input, this.deps.world.world.start.character);
    this.creation = step.creation;
    if (!step.done) return { lines: step.lines };
    await this.deps.store.reset(this.deps.campaignId);
    return { lines: await this.begin(step.done), reset: true };
  }

  /**
   * At most one conversation between NPCs per turn, as it starts. The world engine picks who meets and what each may
   * share; the narrative engine picks what they actually say. If the player is there, they see it happen.
   */
  private async exchange(next: GameState, memories: NpcMemory[]): Promise<{ memories: NpcMemory[]; lines: LogLine[] }> {
    const candidate = findExchange(this.deps.world, memories, next);
    if (!candidate) return { memories: [], lines: [] };
    const labels = { a: npcLabel(candidate.a, next.knownNpcs), b: npcLabel(candidate.b, next.knownNpcs) };
    let choice;
    try {
      choice = await this.deps.narrative.exchange(candidate, labels, next.character.pronouns);
    } catch {
      // Background chatter; the player's turn still stands if it fails, and the pair will try again later.
      return { memories: [], lines: [] };
    }
    const seen = candidate.locationId === next.locationId && choice.summary;
    return {
      memories: applyExchange(candidate, choice, next.turn),
      lines: seen ? [{ kind: "narration", text: choice.summary }] : [],
    };
  }

  /** Spends experience on a level. Costs no action, so it isn't a turn: nobody sees or narrates it. */
  private async levelUp(stat: string | undefined): Promise<LogLine[]> {
    const state = this.game;
    const { character } = state;
    if (!stat) {
      const cost = levelUpCost(character.level);
      return [
        {
          kind: "system",
          text: `Level ${character.level}, ${character.xp} XP. Level ${character.level + 1} costs ${cost} XP and raises a stat by 1: /levelup <${Object.keys(character.stats).join("|")}>.`,
        },
      ];
    }
    const resolution = this.deps.world.levelUp(state, stat);
    if (!resolution.ok) return [{ kind: "system", text: resolution.reason }];
    const next = this.deps.world.apply(state, resolution.events);
    const [event] = resolution.events;
    const raised = event.type === "levelled_up" ? event.stat : stat;
    const lines: LogLine[] = [
      {
        kind: "system",
        text: `You reach level ${next.character.level}: ${raised} rises to ${next.character.stats[raised]}, max HP to ${next.character.maxHp}.`,
      },
    ];
    await this.deps.store.commitTurn(next, {
      turn: next.turn,
      input: `/levelup ${stat}`,
      events: resolution.events,
      output: lines,
    });
    this.state = next;
    return lines;
  }

  /** Debug view of what an NPC remembers. */
  private recall(name: string): LogLine[] {
    const npc = findMatch([...this.deps.world.world.npcs.values()], name, (n) => [n.id, n.name]);
    if (!npc) return [{ kind: "system", text: `No NPC called "${name}".` }];
    const memories = memoriesOf(npc.id, this.memories);
    if (!memories.length) return [{ kind: "system", text: `${npc.name} remembers nothing yet.` }];
    return [
      { kind: "system", text: `${npc.name} remembers:` },
      ...memories.map((m): LogLine => {
        const from = m.source ? ` from ${m.source.name}` : "";
        return { kind: "system", text: `  t${m.turn} ${m.kind}${from} [${m.share}]: ${m.text}` };
      }),
    ];
  }

  private async begin(character?: Character): Promise<LogLine[]> {
    const state = this.deps.world.newGame(this.deps.campaignId, character);
    const output: LogLine[] = [
      { kind: "narration", text: this.deps.world.world.intro },
      { kind: "narration", text: describeScene(this.deps.world.scene(state)) },
      { kind: "system", text: "Type /help for commands." },
    ];
    await this.deps.store.commitTurn(state, { turn: state.turn, input: "", events: [], output });
    this.state = state;
    this.recent = [];
    this.memories = [];
    this.keepRecent(output);
    return output;
  }

  private keepRecent(lines: LogLine[]): void {
    this.recent = [...this.recent, ...lines.filter((l) => l.kind !== "system" && l.kind !== "error")].slice(
      -RECENT_LINES,
    );
  }
}

/**
 * Items for places added to the campaign since the save was made, and hidden items for saves made before
 * there were any. An item the save shows lying about somewhere the player has been stays visible (they've
 * seen it); one in a place they haven't been is hidden, as the campaign now has it.
 */
function placesSince(state: GameState, locations: Iterable<LocationDef>): Pick<GameState, "locationItems" | "hiddenItems"> {
  const all = [...locations];
  const locationItems = { ...state.locationItems };
  for (const l of all) locationItems[l.id] ??= [...l.items];
  if (state.hiddenItems) return { locationItems, hiddenItems: state.hiddenItems };
  const hiddenItems: Record<string, string[]> = {};
  for (const [id, items] of Object.entries(hiddenAtStart(all))) {
    const seen = state.visited?.includes(id) ?? false;
    hiddenItems[id] = items.filter(
      (i) => !state.character.inventory.includes(i) && !(seen && locationItems[id].includes(i)),
    );
    locationItems[id] = locationItems[id].filter((i) => !hiddenItems[id].includes(i));
  }
  return { locationItems, hiddenItems };
}

/** What the player is told when they try to push but can't: nothing to push, or no drive left. */
function driveNote(wantsPush: boolean, intent: Intent, drive: number): LogLine | undefined {
  if (!wantsPush) return undefined;
  if (!intent.check) return { kind: "system", text: "(Nothing here calls for pushing; you keep your drive.)" };
  if (drive === 0) return { kind: "system", text: "(You've no drive left to push with.)" };
  return undefined;
}

function replay(record: TurnRecord): LogLine[] {
  return record.input ? [{ kind: "player", text: record.input }, ...record.output] : record.output;
}
