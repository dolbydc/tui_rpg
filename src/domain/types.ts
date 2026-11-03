// Types shared by every layer. The domain depends on nothing else in the app.

// --- Static world definition, loaded from campaign markdown -----------------

export interface WorldDefinition {
  id: string;
  title: string;
  intro: string;
  /** Tone and rules text given to the narrator. */
  rules: string;
  /** Text-to-speech voice for narration (a Kokoro voice name, e.g. "bm_george"). */
  narratorVoice?: string;
  start: StartingState;
  locations: Map<string, LocationDef>;
  npcs: Map<string, NpcDef>;
  /** Every quest's definition of done and reward, by quest id. */
  quests: Map<string, QuestDef>;
}

export interface QuestDef {
  id: string;
  title: string;
  description: string;
  /** The quest starts once all of these hold; with none, it's active from the beginning. */
  starts: QuestCondition[];
  /** The quest is complete as soon as all of these hold. */
  done: QuestCondition[];
  reward: Reward;
}

/** Something the world engine can check against the game state. */
export type QuestCondition =
  | { kind: "have"; item: string }
  | { kind: "gave"; item: string; npcId: string }
  | { kind: "at"; locationId: string }
  | { kind: "visited"; locationId: string }
  | { kind: "knows"; npcId: string }
  | { kind: "completed"; questId: string };

export interface Reward {
  xp: number;
  items: string[];
}

export interface StartingState {
  locationId: string;
  /** Time of day the campaign starts, in minutes after midnight. */
  time: number;
  character: Character;
  quests: Quest[];
}

export interface LocationDef {
  id: string;
  name: string;
  /** Short name for the map, at most MAP_LABEL characters. */
  label: string;
  /** Where it sits on the map grid: x grows east, y grows south. */
  position: GridPosition;
  description: string;
  /** Exit name (e.g. "north", "inn") to destination location id. */
  exits: Record<string, string>;
  items: string[];
  /** Items here that can't be seen until the player searches for them. */
  hiddenItems: HiddenItemDef[];
  /** A check the player must make on first arriving, e.g. keeping their nerve at something frightening. */
  enterCheck?: CheckRequest;
}

/** Something not immediately visible: buried, behind something, hidden with magic… */
export interface HiddenItemDef {
  item: string;
  /** Where or how it's hidden ("fallen behind the crates"). Told to the narrator only once it's found. */
  hidden?: string;
  /** What the player notices on finding it. */
  found?: string;
  /** A roll that searching needs, to find it; without one, searching here is enough. */
  check?: CheckRequest;
  /** Only findable while the player carries this (something that sees through a glamour, a spade…). */
  needs?: string;
}

export interface GridPosition {
  x: number;
  y: number;
  /** Level: 0 is the ground; up is positive (an upstairs room is 1, a cellar −1). */
  z: number;
}

export interface NpcDef {
  id: string;
  name: string;
  /** How the player refers to them before learning their name, e.g. "the old man". */
  epithet: string;
  /** How they look to someone who doesn't know them, e.g. "a hunched old man in a wool coat". */
  appearance: string;
  /** e.g. "she/her"; used wherever the model refers to them, so narration and actions agree. */
  pronouns: string;
  /** Text-to-speech voice for what they say (a Kokoro voice name); picked from their pronouns if not set. */
  voice?: string;
  /** Where the NPC is when they have no routine. */
  locationId: string;
  /** Location ids cycled through, one per turn (turn n → routine[n % length]). */
  routine?: string[];
  persona: string;
  /** How they talk: vocabulary, grammar, habits of speech. Every line of their dialogue follows it. */
  speech?: string;
  /** 1–5: how much they notice. See NOTICE in world/perception.ts. */
  perception: number;
  /** How freely they pass on what they witness or hear. */
  discretion: Discretion;
  goals: string[];
  knowledge: KnowledgeDef[];
  /** NPC ids they'll tell "trusted" information to. */
  trusts: string[];
}

/**
 * Who a piece of information may be passed to:
 * public → anyone; trusted → only people the holder trusts; secret → no one.
 */
export type ShareLevel = "public" | "trusted" | "secret";

/** An NPC's habit with what they learn: open → public, guarded → trusted, secretive → secret. */
export type Discretion = "open" | "guarded" | "secretive";

export interface KnowledgeDef {
  id: string;
  fact: string;
  share: ShareLevel;
}

// --- Campaign state: everything that changes in play; plain JSON so it persists as-is

export interface Character {
  name: string;
  /** e.g. "she/her"; NPCs and the narrator use these for the player. */
  pronouns: string;
  hp: number;
  maxHp: number;
  level: number;
  /** Experience not yet spent on levelling up. */
  xp: number;
  stats: Record<string, number>;
  inventory: string[];
}

export interface Quest {
  id: string;
  title: string;
  description: string;
  /** pending: not started yet, and hidden from the player. */
  status: "pending" | "active" | "completed";
}

export interface GameState {
  campaignId: string;
  worldId: string;
  turn: number;
  /** In-game seconds since the campaign began; the time of day follows from it. */
  elapsed: number;
  /** The player confronted someone this turn (attacked, intimidated…), so it passes quickly, like a conversation. */
  engaged?: boolean;
  /** Actions the player has left this turn; the turn ends when they run out. */
  actionsLeft: number;
  /** Drive left to push rolls with; restored when a new quest starts. */
  drive: number;
  locationId: string;
  /** Location ids the player has been to, in order: the map shows only these. */
  visited: string[];
  character: Character;
  quests: Quest[];
  /** Items lying in each location, by location id. */
  locationItems: Record<string, string[]>;
  /** Hidden items not found yet, by location id; finding one moves it into locationItems. */
  hiddenItems: Record<string, string[]>;
  /** Items the player has given to NPCs, by NPC id. */
  npcItems: Record<string, string[]>;
  /** NPCs whose names the player has learned, by being told or hearing them mentioned. */
  knownNpcs: string[];
  /** Seconds each NPC's routine has been held back, by NPC id (they pause while talking to the player). */
  routineDelay: Record<string, number>;
  /** Hidden consequences of partial successes, waiting to surface. */
  complications: Complication[];
  /** Lasting changes to places, by location id (e.g. "The valve's handle has snapped off."). */
  locationNotes: Record<string, string[]>;
  /** The NPC the player is talking with, if any. */
  conversation?: Conversation;
}

export interface Conversation {
  npcId: string;
  /** Actions in a row the player has spent not addressing them. */
  idleActions: number;
}

/** What NPC routines are timed by: the time elapsed, less however long each NPC has paused; and the turn. */
export type Clock = Pick<GameState, "turn" | "elapsed" | "routineDelay">;

// --- Turn pipeline -----------------------------------------------------------

/** What the player is trying to do: parsed from a command, or interpreted from free text. */
export type Intent = (
  | { kind: "look" }
  | { kind: "move"; direction: string }
  /** Picking something up. The player may ask for several ("the hook and the key"); only the first is taken. */
  | { kind: "take"; items: string[] }
  | { kind: "talk"; npc: string; message: string }
  | { kind: "give"; item: string; npc: string }
  /** Putting something from the inventory down here. */
  | { kind: "drop"; item: string }
  | { kind: "wait" }
  /** Searching for what's hidden, perhaps somewhere in particular ("behind the crates"). */
  | { kind: "search"; where?: string }
  /** Sleeps until morning: the rest of the night passes. */
  | { kind: "sleep" }
  | { kind: "act"; action: string }
) & {
  /** Set when the outcome is uncertain and risky enough to roll for. */
  check?: CheckRequest;
};

/** A roll the player has to make: which stat, what for, and who it's aimed at, if anyone. */
export interface CheckRequest {
  stat: string;
  /** What's at stake, e.g. "convince the innkeeper they're a royal messenger". */
  why: string;
  /** The person it's aimed at (deceived, attacked…), as the player refers to them. */
  target?: string;
  /** The player wants to push it, spending drive for an extra die. */
  push?: boolean;
  /** The player is trying not to be noticed (sneaking): if it works, nobody witnesses the action. */
  stealth?: boolean;
}

/**
 * How a roll turned out, worst to best. A partial success looks like a success to the player but leaves a
 * hidden complication that surfaces later.
 */
export type CheckOutcome = "failure" | "partial_failure" | "partial_success" | "success";

export interface CheckResult {
  stat: string;
  why: string;
  /** Every die rolled, and the best of them, which is the one that counts. */
  dice: number[];
  die: number;
  bonus: number;
  total: number;
  outcome: CheckOutcome;
  /** The player spent drive on it, for an extra die. */
  pushed?: boolean;
  /** A sneaking attempt: on a success or partial success, NPCs don't witness the action. */
  stealth?: boolean;
  /** The NPC it was aimed at. */
  npcId?: string;
}

/** The delayed cost of a partial success. */
export interface Complication {
  id: string;
  /** Turn of the partial success, and the time (elapsed seconds) from which it may surface. */
  turn: number;
  due: number;
  /** What the player typed, and what the check was for. */
  input: string;
  why: string;
  locationId: string;
  /** An NPC who was fooled, pushed or hurt: they realise what really happened. Otherwise it surfaces at the place. */
  npcId?: string;
}

/** State changes decided by the world engine. Only these change GameState. */
export type WorldEvent =
  | { type: "moved"; from: string; to: string }
  | { type: "item_taken"; item: string; locationId: string }
  | { type: "item_dropped"; item: string; locationId: string }
  /** A hidden item was found: it now lies in plain sight. */
  | { type: "item_found"; item: string; locationId: string }
  | { type: "item_given"; item: string; npcId: string }
  | { type: "quest_started"; questId: string }
  | { type: "quest_completed"; questId: string; reward: Reward }
  | { type: "levelled_up"; stat: string; cost: number }
  /** A roll; changes nothing by itself, but is kept in the record (the player is never shown it). */
  | { type: "checked"; check: CheckResult }
  | { type: "complication_pending"; complication: Complication }
  /** A complication surfaced; `note` is how the place is changed for good, if it surfaced there. */
  | { type: "complication_resolved"; id: string; locationId?: string; note?: string };

export interface Resolved {
  ok: true;
  events: WorldEvent[];
  /** The NPC being addressed, for talk and give intents. */
  npc?: NpcDef;
  /** Parts of the intent that couldn't be done, told to the player (e.g. one of two items isn't here). */
  notes?: string[];
  /** For a search: hidden items it turns up only if a roll goes well (the rest are found at once). */
  search?: { items: HiddenItemDef[]; check: CheckRequest };
}

/** An NPC's routine taking them into or out of the player's sight. */
export interface NpcMovement {
  npc: NpcDef;
  from: string;
  to: string;
  /** arrived: came to where the player is; followed: came along from where the player just was; left: went elsewhere. */
  kind: "arrived" | "followed" | "left";
}

export type Resolution = Resolved | { ok: false; reason: string };

/** The in-game time, which follows from the turn (see world/time.ts). */
export interface TimeOfDay {
  day: number;
  /** Minutes after midnight. */
  minutes: number;
  phase: "dawn" | "morning" | "afternoon" | "evening" | "night";
}

/** What the player sees on the current turn, derived from GameState and the world. */
export interface SceneView {
  location: LocationDef;
  exits: { direction: string; name: string }[];
  npcs: NpcDef[];
  /** Everyone else, who isn't here: given to the model so it gets them right if they're mentioned. */
  others: NpcDef[];
  /** NPC ids whose names the player knows; everyone else is shown by appearance. */
  knownNpcs: string[];
  items: string[];
  /** Lasting changes to this place. */
  notes: string[];
  time: TimeOfDay;
  /** Places the player has been (other than here), which they can travel back to along known paths. */
  knownPlaces: { id: string; name: string }[];
  character: Character;
  quests: Quest[];
}

/** The places the player has visited on the level they're on, laid out on the grid. */
export interface MapView {
  /** The level shown (GridPosition.z). */
  level: number;
  cells: MapCell[];
  /** Exits from a visited place to a neighbouring cell; `to` may not have been visited yet. */
  links: { from: GridPosition; to: GridPosition }[];
}

export interface MapCell {
  id: string;
  label: string;
  position: GridPosition;
  /** The player is here. */
  here: boolean;
  /** People the player can see here (only where the player is): a known person's initial, otherwise undefined. */
  people: (string | undefined)[];
  /** Items lying here. */
  items: number;
  /** Exits up or down to another level. */
  stairs: { up: boolean; down: boolean };
}

export interface LogLine {
  kind: "player" | "narration" | "npc" | "system" | "error";
  text: string;
  /** For npc lines: how the player knows the speaker (name or epithet), and who it is. */
  speaker?: string;
  npcId?: string;
}

/** Something one NPC remembers. Stored per NPC; grows as they witness, talk and hear things. */
export interface NpcMemory {
  id: string;
  npcId: string;
  turn: number;
  /** witnessed: saw it happen; conversation: took part in it; heard: told by another NPC. */
  kind: "witnessed" | "conversation" | "heard";
  /** "player", an NPC id, or "world". */
  about: string;
  /** Neutral, third-person statement of what they remember. */
  text: string;
  /** How far this NPC will pass it on. */
  share: ShareLevel;
  /** Id of the original fact (a knowledge id or the first memory), so a relayed fact isn't learned twice. */
  origin: string;
  /** For heard memories: who told them. */
  source?: { npcId: string; name: string };
  /** For a conversation with the player: what this NPC said, word for word, so they don't say it again. */
  said?: string;
}

/** One processed player action, as stored in the campaign's event history. */
export interface TurnRecord {
  turn: number;
  input: string;
  intent?: Intent;
  events: WorldEvent[];
  output: LogLine[];
}
