import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAMPAIGN_DIR } from "../config.js";
import { WorldEngine } from "../world/engine.js";
import { loadWorld } from "../world/loader.js";
import { describeScene, presentToPlayer } from "./describe.js";
import { parseIntent } from "./engine.js";
import type { NpcMemory } from "../domain/types.js";
import type { LlmProvider } from "../llm/provider.js";
import { recall, type Recollection } from "../world/memory.js";
import { NarrativeEngine } from "./engine.js";
import { dialogueMessages, interpretMessages, narrationMessages } from "./prompts.js";
import { repeated } from "./repetition.js";

const NONE: Recollection = { talked: [], saw: [], heard: [] };

test("parses each intent shape", () => {
  assert.deepEqual(parseIntent('{"kind":"look"}', "x"), { kind: "look" });
  assert.deepEqual(parseIntent('{"kind":"move","direction":" east "}', "x"), { kind: "move", direction: "east" });
  assert.deepEqual(parseIntent('{"kind":"talk","npc":"Pell"}', "hello pell"), {
    kind: "talk",
    npc: "Pell",
    message: "hello pell",
  });
});

test("a take can list several items", () => {
  assert.deepEqual(parseIntent('{"kind":"take","items":["hook on a stick","an iron key"]}', "x"), {
    kind: "take",
    items: ["hook on a stick", "an iron key"],
  });
});

test("tolerates text around the JSON", () => {
  assert.deepEqual(parseIntent('```json\n{"kind":"take","item":"cup"}\n```', "x"), { kind: "take", items: ["cup"] });
});

test("falls back to a generic action on malformed output", () => {
  const fallback = { kind: "act", action: "dance a jig" };
  assert.deepEqual(parseIntent("not json", "dance a jig"), fallback);
  assert.deepEqual(parseIntent('{"kind":"fly"}', "dance a jig"), fallback);
  assert.deepEqual(parseIntent('{"kind":"move"}', "dance a jig"), fallback);
});

test("mid-conversation, the interpreter is told who the player is talking with", async () => {
  const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
  const scene = world.scene(world.newGame("t"));
  const pell = world.npc("old-pell");

  assert.doesNotMatch(interpretMessages("Which way?", scene)[1].content, /in conversation/);
  assert.match(interpretMessages("Which way?", scene, pell)[1].content, /in conversation with the old man/);
});

test("the model is told NPCs' pronouns; the player's scene doesn't show them", async () => {
  const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
  const scene = world.scene({ ...world.newGame("t"), locationId: "hollow-lantern-inn" });
  assert.match(interpretMessages("hello", scene)[1].content, /a broad, tired-looking woman keeping the bar \(she\/her\)/);
  assert.doesNotMatch(describeScene(scene), /she\/her/);
});

test("the player character's pronouns reach NPC dialogue and narration", async () => {
  const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
  const state = world.newGame("t");
  state.character.pronouns = "she/her";
  const scene = world.scene(state);
  const pell = world.npc("old-pell");
  const dialogue = dialogueMessages("", pell, scene, [], "Hello", NONE, { given: [], knowsYourName: false });
  assert.match(dialogue[0].content, /a stranger in town \(she\/her\)/);
  const narration = narrationMessages("", scene, [], "look", "Nothing changes.");
  assert.match(narration[1].content, /pronouns: she\/her/);
});

test("the narrator is told who isn't here, with pronouns, and to stop where the player is", async () => {
  const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
  const scene = world.scene({ ...world.newGame("t"), turn: 1, locationId: "forest-edge" });
  const prompt = narrationMessages("", scene, [], "go back to the inn and tell the innkeeper", "The player moved.")[1].content;
  assert.match(prompt, /not here, and can't appear.*the innkeeper \(she\/her\); the old man \(he\/him\)/);
  assert.match(prompt, /ending with the player where they are now: Edge of the Thornwood/);
  assert.doesNotMatch(prompt, /Marta/, "names the player hasn't learned stay out");

  const dialogue = dialogueMessages("", world.npc("old-pell"), world.scene(world.newGame("t")), [], "Hi", NONE, {
    given: [],
    knowsYourName: false,
  });
  assert.match(dialogue[1].content, /Other people in town, who aren't here: Marta Vell, the innkeeper \(she\/her\)/);
});

const memory = (fields: Partial<NpcMemory> & Pick<NpcMemory, "kind" | "text">): NpcMemory => ({
  id: Math.random().toString(36),
  npcId: "marta",
  turn: 1,
  about: "player",
  share: "public",
  origin: Math.random().toString(36),
  ...fields,
});

test("a reply that says a sentence again, or reuses enough phrases, is caught; a fresh one isn't", () => {
  const past = [`"Evening, traveller. The lantern's been dark three nights now, and nobody will say why." *She wipes the bar.*`];
  assert.deepEqual(repeated(`"Aye. The lantern's been dark three nights now, and nobody will say why."`, past), [
    "The lantern's been dark three nights now, and nobody will say why.",
  ]);
  assert.ok(repeated(`Like I said, the lantern's been dark three nights now and that's all.`, past).length);
  // One long line said again, in a longer reply.
  assert.deepEqual(
    repeated(`"I told you, love, it's gone missing and left a bit of a chill in the air. I'm still looking for news of it."`, [
      `"It's gone missing, and it's left a bit of a chill in the air." *She wipes the counter.* "I'm Marta, by the way."`,
    ]),
    ["left a bit of a chill in the air"],
  );
  assert.deepEqual(repeated(`"Pell might know more. He was out by the trees last night."`, past), []);
  // Short sentences and actions are fair to repeat.
  assert.deepEqual(repeated(`"Evening." *She wipes the bar.* "Room's upstairs if you want it."`, ["Evening.", "*She wipes the bar.*"]), []);
});

test("an NPC recalls conversations, sightings and gossip separately, so movements don't crowd out what was said", async () => {
  const memories = [
    memory({ kind: "conversation", text: `The stranger said to Marta: "Hi" Marta replied: Evening.`, said: "Evening." }),
    ...Array.from({ length: 30 }, (_, i) => memory({ kind: "witnessed", text: `Saw the stranger come in (${i}).` })),
    memory({ kind: "heard", text: "The stranger was poking about the woods.", source: { npcId: "old-pell", name: "Pell" } }),
    memory({ kind: "conversation", about: "old-pell", text: "Talked with Pell." }),
  ];
  const recalled = recall("marta", memories);
  assert.equal(recalled.talked.length, 1);
  assert.equal(recalled.saw.length, 12);
  assert.deepEqual(recalled.heard.map((m) => m.text), ["The stranger was poking about the woods.", "Talked with Pell."]);

  const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
  const prompt = dialogueMessages("", world.npc("marta"), world.scene(world.newGame("t")), [], "Hi", recalled, {
    given: [],
    knowsYourName: false,
  })[0].content;
  assert.match(prompt, /said to each other before[^]*Marta replied: Evening\.[^]*seen yourself[^]*come in \(29\)[^]*others have told you[^]*heard from Pell\) The stranger was poking/);
  assert.match(prompt, /Never repeat yourself/);
});

test("an NPC who repeats themselves is asked once more for something new", async () => {
  const asked: string[][] = [];
  const replies = [`"The lantern's been dark three nights now, and nobody will say why."`, `"Ask Pell. He sees more than he lets on."`];
  const llm: LlmProvider = {
    name: "fake",
    complete: async ({ messages }) => {
      asked.push(messages.map((m) => m.content));
      return replies.shift()!;
    },
  };
  const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
  const state = world.newGame("t");
  const marta = world.npc("marta");
  const talked = [memory({ kind: "conversation", text: "…", said: `"The lantern's been dark three nights now, and nobody will say why."` })];
  const lines = await new NarrativeEngine(llm, "").narrate({
    input: "what's wrong here?",
    intent: { kind: "talk", npc: "marta", message: "What's wrong here?" },
    resolution: { ok: true, events: [], npc: marta },
    scene: world.scene(state),
    recent: [],
    memories: { talked, saw: [], heard: [] },
  });
  assert.equal(lines[0].text, `"Ask Pell. He sees more than he lets on."`);
  assert.equal(asked.length, 2);
  assert.match(asked[1].at(-1)!, /You've said this to the stranger before: "The lantern's been dark/);
});

test("each NPC's way of speaking reaches their dialogue prompt", async () => {
  const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
  const scene = world.scene(world.newGame("t"));
  for (const id of ["marta", "old-pell"]) {
    const npc = world.npc(id);
    assert.ok(npc.speech);
    const prompt = dialogueMessages("", npc, scene, [], "Hi", NONE, { given: [], knowsYourName: false })[0].content;
    assert.ok(prompt.includes(`How you speak (every word you say must sound like this; any example lines show the sound only, never say them):\n${npc.speech}`));
  }
});

test("people who share a family name are each shown as the player knows them", async () => {
  const world = await loadWorld(`${DEFAULT_CAMPAIGN_DIR}/../those-dark-places`);
  const npcs = [...world.npcs.values()];
  const show = (text: string, known: string[]) => presentToPlayer([{ kind: "narration", text }], npcs, known)[0].text;
  const text = "Teo Varga looks up. Ines Varga is his sister; Varga is a common name here.";
  assert.equal(show(text, ["teo"]), "Teo Varga looks up. The foreman is his sister; Varga is a common name here.");
  // Known to neither: a bare family name is masked as one of them, never shown.
  assert.match(show(text, []), /^The survivor looks up\. The foreman is his sister; the (survivor|foreman) is a common/);
  assert.equal(show(text, ["teo", "ines"]), text);
});

test("a title isn't a name: hearing it doesn't introduce anyone", async () => {
  const world = new WorldEngine(await loadWorld(`${DEFAULT_CAMPAIGN_DIR}/../those-dark-places`));
  const state = world.newGame("t");
  assert.deepEqual(world.namesHeard(["Take it up with the administrator, or ask a brother of the Quiet Shift."], state), []);
  assert.deepEqual(world.namesHeard(["Hask runs this place."], state).map((n) => n.id), ["hask"]);
});
