import type { CheckResult, Complication, LogLine, NpcDef, NpcMemory, SceneView, ShareLevel } from "../domain/types.js";
import type { Recollection } from "../world/memory.js";
import type { ChatMessage } from "../llm/provider.js";
import type { ExchangeCandidate, Fact } from "../world/sharing.js";
import { describeTime } from "../world/time.js";
import { checkOnNpc, describeScene, formatRecent, NO_DICE, npcLabel } from "./describe.js";

/** What each stat is rolled for, so the interpreter picks the right one. */
const STAT_USES: Record<string, string> = {
  might: "force, fighting hand to hand, endurance",
  wits: "noticing, knowing, keeping your nerve against fear",
  grace: "agility, stealth, aim, sleight of hand",
  charisma: "deceiving, persuading, charming, intimidating",
};

/** `partner` is who the player is mid-conversation with, if anyone. */
export function interpretMessages(input: string, scene: SceneView, partner?: NpcDef): ChatMessage[] {
  const stats = Object.keys(scene.character.stats)
    .map((stat) => (STAT_USES[stat] ? `${stat} (${STAT_USES[stat]})` : stat))
    .join(", ");
  const talking = partner
    ? `\nThe player is in conversation with ${npcLabel(partner, scene.knownNpcs)}: unless they clearly address someone else or do something else, what they say (even a bare question) is said to them.`
    : "";
  return [
    {
      role: "system",
      content: `You interpret what a player types in a text adventure and turn it into one JSON intent.
Reply with only a JSON object in one of these shapes:
{"kind":"look"}  - the player looks around or examines the surroundings
{"kind":"move","direction":"..."}  - the player goes somewhere; direction is one exit from the scene (just its name, e.g. "out", or just its destination), or a place they've been before (they know the way back), by its name
{"kind":"take","items":["..."]}  - the player picks something up; list every item they mean, each by its name from the scene
{"kind":"talk","npc":"...","message":"..."}  - the player speaks to someone; npc is the person they are speaking TO, copied exactly as the scene lists them (name or description, not a paraphrase), not someone they are asking about (if the player addresses no one in particular, whoever would most naturally answer, e.g. the host of the place), message is what the player says
{"kind":"drop","item":"..."}  - the player puts down, drops, leaves or sets out one of their inventory items here (add a check only if placing it just so is genuinely tricky, like stacking crates neatly)
{"kind":"give","item":"...","npc":"..."}  - the player hands one of their inventory items to someone in the scene; npc copied exactly as the scene lists them
{"kind":"wait"}  - the player waits, rests or lets time pass without doing anything
{"kind":"sleep"}  - the player goes to sleep for the night
{"kind":"search","where":"..."}  - the player searches, digs, feels around, or looks behind, under or inside something for what's hidden; where is the spot, if they name one (leave it out for a general search). Glancing around is "look", not "search"
{"kind":"act","action":"..."}  - anything else; action briefly restates what the player attempts

Add "check" to an intent (not look or wait) only when the outcome is genuinely uncertain and failing would matter:
"check":{"stat":"...","why":"...","target":"..."}
- stat: one of the player's stats: ${stats}
- why: what the player is trying to achieve, phrased to follow "trying to", e.g. "pass themselves off as a royal messenger"
- target: the person in the scene it's aimed at; leave it out if it isn't aimed at a person
If the player is trying not to be seen or noticed (sneaking, slipping past, moving quietly, doing something unobserved), use grace and add "stealth":true inside check. Sneaking somewhere is still a move (to that place), with the check.
Only if the player says they're giving it everything (pushing themselves, digging deep, all or nothing), add "push":true inside check; otherwise never include "push".
Needs a check: sneaking, lying or bluffing, persuading someone against their interests, intimidating, attacking, sneaking, picking a pocket, climbing, forcing a lock, steadying yourself against something terrifying.
No check: ordinary conversation and honest questions, looking around, walking, picking things up, giving things.

Who is being spoken to: a person the player talks ABOUT (in the third person, e.g. "that old man", "Pell said…", "is Marta…") is not the one being spoken to; pick someone else in the scene. A person addressed directly ("Old man, …", "Marta, …", "I ask Pell …") is.
Example, with an innkeeper and an old man in the scene:
"Is that old man a regular here?" → {"kind":"talk","npc":"the innkeeper","message":"Is that old man a regular here?"}
"Old man, is the innkeeper always this grumpy?" → {"kind":"talk","npc":"the old man","message":"Is the innkeeper always this grumpy?"}
"I tell the innkeeper I'm the magistrate's nephew, so she'd better talk" → {"kind":"talk","npc":"the innkeeper","message":"I'm the magistrate's nephew, so you'd better talk.","check":{"stat":"charisma","why":"pass themselves off as the magistrate's nephew","target":"the innkeeper"}}
"I sneak past the old man into the inn" → {"kind":"move","direction":"inn","check":{"stat":"grace","why":"slip past the old man unseen","stealth":true}}
"I shove the old man off the well" → {"kind":"act","action":"shove the old man off the well","check":{"stat":"might","why":"shove the old man off the well","target":"the old man"}}`,
    },
    {
      role: "user",
      content: `Scene:\n${describeScene(scene, { forModel: true })}\nPlaces the player has been: ${scene.knownPlaces.map((p) => p.name).join(", ") || "(none)"}\nPlayer's inventory: ${scene.character.inventory.join(", ")}${talking}\n\nPlayer input: ${input}`,
    },
  ];
}

export function narrationMessages(
  rules: string,
  scene: SceneView,
  recent: LogLine[],
  input: string,
  outcome: string,
): ChatMessage[] {
  return [
    { role: "system", content: `You are the narrator of a text RPG.\n\n${rules}` },
    {
      role: "user",
      content: `Scene:
${describeScene(scene, { forModel: true })}

Recent events:
${formatRecent(recent)}

People who are not here, and can't appear, speak or act in this narration: ${absent(scene, "player")}
The player character's pronouns: ${scene.character.pronouns}.
The player typed: ${input}
Outcome decided by the world engine (authoritative): ${outcome}

Narrate only that outcome, ending with the player where they are now: ${scene.location.name}. If the player meant to do more (go further, find someone, hand something over, say something), that hasn't happened yet; don't narrate it.`,
    },
  ];
}

export function dialogueMessages(
  rules: string,
  npc: NpcDef,
  scene: SceneView,
  recent: LogLine[],
  message: string,
  memories: Recollection,
  player: DialoguePlayer,
  /** A rolled attempt on this NPC (deceiving, persuading…), and how it went. */
  attempt?: CheckResult,
): ChatMessage[] {
  const swayed = attempt ? `\n\nHow the stranger's words land (decided for you; never mention it): ${checkOnNpc(attempt)} ${NO_DICE}` : "";
  const yourName = player.knowsYourName
    ? `The stranger knows your name.`
    : `The stranger doesn't know your name; tell them if and when it suits you. In *actions*, call yourself "${npc.epithet}", not by name.`;
  const self = `Your pronouns are ${npc.pronouns}.`;
  const known = (share: ShareLevel) => npc.knowledge.filter((k) => k.share === share).map((k) => k.fact);
  const pronouns = scene.character.pronouns;
  const who = player.name
    ? `${player.name} (${pronouns}), the stranger in town. "The stranger" in your memories is ${player.name}.`
    : `a stranger in town (${pronouns}) whose name you don't know: never call them by a name. "The stranger" in your memories is this person.`;
  return [
    {
      role: "system",
      content: `You are ${npc.name}, a character in a text RPG.

${npc.persona}
${npc.speech ? `
How you speak (every word you say must sound like this; any example lines show the sound only, never say them):
${npc.speech}
` : ""}
Your goals:
${list(npc.goals)}

What you know, and will talk about:
${list(known("public"))}

What you'd only tell someone who has earned your trust (a stranger hasn't, yet):
${list(known("trusted"))}

Your secrets. Never reveal, hint at or confirm these, not even indirectly or in part. If pressed, deflect, change the subject or lie, in character:
${list(known("secret"))}

What you and the stranger have said to each other before, oldest first. You've already said all of this:
${list(memories.talked.map(formatMemory))}

What you've seen yourself, oldest first:
${list(memories.saw.map(formatMemory))}

What others have told you, oldest first:
${list(memories.heard.map(formatMemory))}

Things the stranger has given you: ${player.given.length ? player.given.join(", ") : "nothing"}

You are talking to ${who}
${yourName} ${self}

World rules and tone:
${rules}

Stay in character, speak in your own voice (never repeat what someone else said), and pursue your goals. Never repeat yourself: don't reuse a greeting, phrase, description or piece of news you've already given the stranger. If they ask about something you've told them already, answer it briefly in new words, perhaps with a detail you haven't mentioned. Otherwise move the conversation on: something new you know, saw or heard, a question, or what you want from them. Use what you know and remember when it's relevant, and respect the brackets in your memories the same way: never reveal anything marked secret. ${npc.speech ? "Speak only as described under \"How you speak\": your words, your grammar. " : ""}Reply with only what you say aloud, in one to three sentences; you may add a brief action in *asterisks*, written in the third person (never "I say" or "*I lean*"). Never narrate for the player or decide their actions.
Example of the form: "Evening." *${capitalize(npc.epithet)} sets down a cup.* "What brings you here?"`,
    },
    {
      role: "user",
      content: `You are at ${scene.location.name}. It is ${describeTime(scene.time)}: keep what you say about the time of day consistent with it. Other people in town, who aren't here: ${absent(scene, "npc")}.

Recent events:
${formatRecent(recent)}

The stranger says to you: "${message}"${swayed}`,
    },
  ];
}

/** Asks for the delayed cost of a partial success, as it surfaces in front of the player. */
export function complicationMessages(
  rules: string,
  scene: SceneView,
  recent: LogLine[],
  complication: Complication,
): ChatMessage[] {
  return [
    { role: "system", content: `You are the narrator of a text RPG.\n\n${rules}` },
    {
      role: "user",
      content: `Scene:
${describeScene(scene, { forModel: true })}

Recent events:
${formatRecent(recent)}

Some turns ago, here, the player tried to ${complication.why} (they typed: "${complication.input}"). It seemed to work. Now its hidden flaw surfaces: what they did gives way, backfires or comes undone, in a way that lasts and can't simply be put right (a mended thing breaks for good, a hidden thing is found, a trick is exposed). Don't move the player, add or remove items, or hurt them. ${NO_DICE}

Reply with only a JSON object:
{"narration": "...", "lasting": "..."}
narration: one or two sentences, second person, present tense, of the player seeing it happen.
lasting: one short sentence, present tense, of how this place is now changed, to describe it from now on.`,
    },
  ];
}

export interface DialoguePlayer {
  /** The player's name, if this NPC has learned it. */
  name?: string;
  /** What the player has given this NPC. */
  given: string[];
  /** Whether the player has learned this NPC's name. */
  knowsYourName: boolean;
}

export function exchangeMessages(
  { a, b, aToB, bToA }: ExchangeCandidate,
  labels: { a: string; b: string },
  strangerPronouns: string,
): ChatMessage[] {
  const side = (npc: NpcDef, label: string, facts: Fact[]) => `${label}: ${npc.name}
${npc.persona}
Goals:
${list(npc.goals)}
What ${npc.name} could tell the other:
${facts.length ? facts.map((f, i) => `${label}${i + 1}. ${f.text}`).join("\n") : "(nothing)"}`;

  return [
    {
      role: "system",
      content: `Two characters in a text RPG meet and talk. Decide what each tells the other.
"The stranger" is the player character (${strangerPronouns}).
Each may only pass on items from their own list. A character shares what serves their goals or answers what the other would ask about given the other's goals, and keeps back anything they have no reason to share.
Reply with only a JSON object:
{"a_tells_b": ["A1", ...], "b_tells_a": ["B1", ...], "summary": "..."}
List items by their ids (A1, B2, ...), not their text; use an empty list if they share nothing.
summary is one sentence of what an onlooker would see: how they talk, not what they say. In it, refer to A only as "${labels.a}" and to B only as "${labels.b}".`,
    },
    { role: "user", content: `${side(a, "A", aToB)}\n\n${side(b, "B", bToA)}` },
  ];
}

const SHARE_HINT: Record<ShareLevel, string> = {
  public: "",
  trusted: "[only share with someone who has earned your trust]",
  secret: "[secret: never reveal]",
};

function formatMemory(memory: NpcMemory): string {
  const how =
    memory.kind === "heard" ? `heard from ${memory.source?.name ?? "someone"}` : memory.kind === "witnessed" ? "saw" : "talked";
  return `(turn ${memory.turn}, ${how}) ${memory.text} ${SHARE_HINT[memory.share]}`.trimEnd();
}

/**
 * The people not in the scene, with pronouns: as the player knows them (for narration), or by name (for an
 * NPC, who knows everyone).
 */
function absent(scene: SceneView, view: "player" | "npc"): string {
  if (!scene.others.length) return "(none)";
  return scene.others
    .map((npc) => (view === "npc" ? `${npc.name}, ${npc.epithet}` : npcLabel(npc, scene.knownNpcs)) + ` (${npc.pronouns})`)
    .join("; ");
}

function list(items: string[]): string {
  return items.length ? items.map((item) => `- ${item.trimEnd()}`).join("\n") : "(none)";
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
