import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAMPAIGN_DIR } from "../config.js";
import type { GameState } from "../domain/types.js";
import { MockProvider, type MockResponder } from "../llm/mock.js";
import { describeScene } from "../narrative/describe.js";
import { NarrativeEngine } from "../narrative/engine.js";
import { InMemoryStore } from "../storage/memory.js";
import { WorldEngine } from "../world/engine.js";
import { loadWorld } from "../world/loader.js";
import { fixedDice as dice } from "../world/checks.js";
import { SessionController } from "./session.js";

const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
/** The cellar's pile of crates, as the content has it ("6 crates"). */
const CRATES = world.location("inn-cellar").items[0];

function setup(respond?: MockResponder, store = new InMemoryStore(), rng?: () => number) {
  const llm = new MockProvider(respond);
  const session = new SessionController({
    world: rng ? new WorldEngine(world.world, rng) : world,
    narrative: new NarrativeEngine(llm, world.world.rules),
    store,
    campaignId: "test",
  });
  return { session, llm, store };
}

test("slash commands run without the LLM", async () => {
  const { session, llm } = setup();
  await session.start();

  const moved = await session.submit("/go inn");
  assert.match(moved.lines[0].text, /^The Hollow Lantern/);
  assert.equal(session.scene.location.id, "hollow-lantern-inn");

  await session.submit("/take cup");
  assert.ok(session.scene.character.inventory.includes("tin cup"));
  assert.equal(llm.requests.length, 0);
});

test("free text is interpreted, resolved, then narrated", async () => {
  const { session, llm } = setup((req) => (req.json ? '{"kind":"move","direction":"east"}' : "Brambles scratch at you."));
  await session.start();

  const result = await session.submit("I head toward the woods");
  assert.deepEqual(result.lines, [{ kind: "narration", text: "Brambles scratch at you." }]);
  assert.equal(session.scene.location.id, "forest-edge");
  // The narrator is told the authoritative outcome.
  assert.match(llm.requests[1].messages[1].content, /moved to Edge of the Thornwood/);
});

test("talk intents get an in-character NPC reply", async () => {
  const { session } = setup((req) => (req.json ? '{"kind":"talk","npc":"the old man","message":"hello"}' : "Eh? Speak up!"));
  await session.start();

  const result = await session.submit("say hello to the old man");
  assert.deepEqual(result.lines, [{ kind: "npc", speaker: "The old man", npcId: "old-pell", text: "Eh? Speak up!" }]);
});

test("an impossible intent is reported and not persisted", async () => {
  const { session, store } = setup();
  await session.start();

  const result = await session.submit("/go up");
  assert.equal(result.lines[0].kind, "system");
  assert.equal((await store.load("test"))?.state.actionsLeft, 3, "it costs no action");
  assert.equal((await store.load("test"))?.recent.length, 1, "only the opening is recorded");
});

test("LLM failures surface as errors without changing state", async () => {
  const { session } = setup(() => {
    throw new Error("connection refused");
  });
  await session.start();

  const result = await session.submit("look around");
  assert.equal(result.lines[0].kind, "error");
  assert.equal(session.scene.location.id, "village-square");
});

test("resumes a saved campaign from the store", async () => {
  const store = new InMemoryStore();
  const first = setup(undefined, store).session;
  await first.start();
  await first.submit("/go east");
  await first.submit("/take glass");

  const resumed = setup(undefined, store).session;
  const lines = await resumed.start();
  assert.equal(resumed.scene.location.id, "forest-edge");
  assert.ok(resumed.scene.character.inventory.includes("shard of lantern glass"));
  assert.match(lines.at(-1)!.text, /Resumed at turn 1/);
  assert.deepEqual(resumed.status, { turn: 1, actionsLeft: 1, actionsPerTurn: 3, nextLevelXp: 100, drive: 2, drivePerQuest: 2, time: { day: 1, minutes: 1200, phase: "night" } });
  assert.deepEqual(resumed.map.cells.map((c) => c.id), ["village-square", "forest-edge"]);
});

test("NPCs remember what they saw, and the memories survive a restart", async () => {
  const store = new InMemoryStore();
  const first = setup(undefined, store).session;
  await first.start();
  await first.submit("/go east");

  const resumed = setup(undefined, store).session;
  await resumed.start();
  const recall = await resumed.submit("/memories pell");
  assert.match(recall.lines[1].text, /witnessed \[public\]: The stranger left Brackenford Square, heading east/);
});

test("NPCs who meet relay what they know, and it shapes what they later tell the player", async () => {
  const onlooker = "Marta and Old Pell trade low words by the fire.";
  const { session, llm, store } = setup((req) => {
    if (req.messages[0].content.startsWith("Two characters")) {
      // Everyone tells everything they're allowed to; ids beyond what was offered are ignored.
      const ids = (label: string) => Array.from({ length: 8 }, (_, i) => `${label}${i + 1}`);
      return JSON.stringify({ a_tells_b: ids("A"), b_tells_a: ids("B"), summary: onlooker });
    }
    return "Hm.";
  });
  await session.start();
  await session.submit("/go east"); // turn 1: Pell, in the square, sees Wren head east
  await session.submit("/go west"); // and come back
  await session.submit("/wait");
  await session.submit("/go east"); // turn 2: and again
  await session.submit("/go west");
  // Wren's last action of turn 2 takes them into the inn; Pell heads there for his supper as turn 3
  // begins, and he and Marta talk in front of Wren.
  const meeting = await session.submit("/go inn");
  assert.deepEqual(
    meeting.lines.slice(1).map((l) => l.text),
    // Names the player hasn't learned are shown as epithets, even if the model uses them.
    [
      "The old man follows you from Brackenford Square.",
      "The innkeeper and the old man trade low words by the fire.",
      "— Turn 3 —",
    ],
  );

  const { memories } = (await store.load("test"))!;
  const heard = (npcId: string) => memories.filter((m) => m.npcId === npcId && m.kind === "heard");
  assert.ok(heard("marta").some((m) => /heading east toward Edge of the Thornwood/.test(m.text)));
  assert.ok(heard("marta").some((m) => /small figure/.test(m.text)));
  assert.ok(heard("old-pell").some((m) => /grandmother/.test(m.text)), "Marta trusts Pell with her worry");
  assert.ok(!memories.some((m) => /key|ale money/.test(m.text)), "secrets stay secret");

  // Talking to Marta afterwards, she draws on what Pell told her.
  await session.submit("/talk innkeeper Have you seen anything strange?");
  const dialogue = llm.requests.at(-1)!.messages[0].content;
  assert.match(dialogue, /heard from Old Pell\) The stranger left Brackenford Square, heading east/);
});

test("an NPC only uses the player's name after being told it", async () => {
  const { session, llm } = setup(() => "Eh?");
  await session.start();

  await session.submit("/talk man Evening, old timer.");
  const before = llm.requests.at(-1)!.messages.map((m) => m.content).join("\n");
  assert.doesNotMatch(before, /Wren/);
  assert.match(before, /whose name you don't know/);

  await session.submit("/talk man The name's Wren.");
  await session.submit("/talk man So, about that lantern.");
  // (Pell then heads to the inn and gossips with Marta, so pick out his dialogue prompt.)
  const after = llm.requests.findLast((r) => r.messages[0].content.startsWith("You are Old Pell"))!.messages[0].content;
  const pronouns = world.world.start.character.pronouns;
  assert.ok(after.includes(`talking to Wren (${pronouns}), the stranger in town`));
});

test("a gift is saved, and the NPC knows what they were given", async () => {
  const store = new InMemoryStore();
  const { session, llm } = setup(() => "Bless you.", store);
  await session.start();

  const gave = await session.submit("/give coin to the old man");
  assert.equal(gave.lines[0].text, "You give the old man a copper coin.");
  assert.ok(session.scene.character.inventory.includes("2 copper coins"));
  assert.deepEqual((await store.load("test"))?.state.npcItems, { "old-pell": ["copper coin"] });

  await session.submit("/talk man Spend it on something warm.");
  assert.match(llm.requests.at(-1)!.messages[0].content, /Things the stranger has given you: copper coin/);
});

test("the player doesn't know NPCs' names until they hear them said", async () => {
  let reply = "*Pell scratches his chin.* Cold one tonight.";
  const { session } = setup(() => reply);
  const intro = await session.start();
  assert.match(intro[1].text, /People here: a hunched old man in a sodden wool coat/);
  assert.doesNotMatch(intro.map((l) => l.text).join("\n"), /Pell/);

  // Names aren't usable before they're known.
  assert.match((await session.submit("/talk pell Evening.")).lines[0].text, /nobody called "pell"/);

  // A name in the model's *actions* isn't heard: it's shown as the epithet and not learned.
  const unnamed = await session.submit("/talk man Evening.");
  assert.deepEqual(unnamed.lines, [
    { kind: "npc", speaker: "The old man", npcId: "old-pell", text: "*The old man scratches his chin.* Cold one tonight." },
  ]);

  // Saying it aloud is how the player learns it.
  reply = "*He sniffs.* Folk call me Old Pell.";
  const named = await session.submit("/talk man Who are you?");
  assert.equal(named.lines[0].speaker, "Old Pell");
  assert.equal(named.lines.at(-1)?.text, "(You now know the old man as Old Pell.)");
  assert.match(describeScene(session.scene), /People here: Old Pell/);

  // He waits while they talk (his routine is paused), and now answers to his name.
  assert.doesNotMatch((await session.submit("/look")).lines.map((l) => l.text).join("\n"), /leaves/);
  assert.equal((await session.submit("/talk pell Thanks.")).lines[0].speaker, "Old Pell");
});

test("the player can learn a name from someone else mentioning it", async () => {
  const { session } = setup(() => "Ask Marta at the inn, she'll know.");
  await session.start();
  const result = await session.submit("/talk man Who runs the inn?");
  assert.equal(result.lines.at(-1)?.text, "(You now know the innkeeper as Marta Vell.)");
  await session.submit("/go inn");
  assert.match((await session.submit("/look")).lines[0].text, /People here: Marta Vell/);
});

test("each turn has three actions; looking is free, waiting ends the turn, and NPCs move between turns", async () => {
  const { session } = setup();
  await session.start();
  assert.deepEqual(session.status, { turn: 1, actionsLeft: 3, actionsPerTurn: 3, nextLevelXp: 100, drive: 2, drivePerQuest: 2, time: { day: 1, minutes: 1200, phase: "night" } });

  await session.submit("/look");
  assert.equal(session.status.actionsLeft, 3);
  await session.submit("/take notice");
  await session.submit("do a little dance");
  assert.deepEqual(session.status, { turn: 1, actionsLeft: 1, actionsPerTurn: 3, nextLevelXp: 100, drive: 2, drivePerQuest: 2, time: { day: 1, minutes: 1200, phase: "night" } });

  const last = await session.submit("/go inn");
  assert.equal(last.lines.at(-1)?.text, "— Turn 2 —");
  assert.deepEqual(session.status, { turn: 2, actionsLeft: 3, actionsPerTurn: 3, nextLevelXp: 100, drive: 2, drivePerQuest: 2, time: { day: 1, minutes: 1210, phase: "night" } });

  // Pell stays in the square until turn 3; waiting out turn 2 brings him in for his supper.
  const waited = await session.submit("/wait");
  assert.deepEqual(waited.lines.map((l) => l.text), [
    "You wait a while.",
    "The old man arrives from Brackenford Square.",
    "— Turn 3 —",
  ]);
});

test("the map shows only where the player has been, and who's there with them", async () => {
  const { session } = setup((req) => (req.json ? "{}" : "*He sniffs.* Folk call me Old Pell."));
  await session.start();
  const cell = (id: string) => session.map.cells.find((c) => c.id === id);
  assert.deepEqual(session.map.cells.map((c) => c.id), ["village-square"]);
  assert.deepEqual(cell("village-square")?.people, [undefined], "someone whose name Wren doesn't know");
  // Exits lead off to the inn and the woods, though neither is on the map yet.
  assert.deepEqual(session.map.links.map((l) => l.to), [
    { x: 0, y: -1, z: 0 },
    { x: 1, y: 0, z: 0 },
  ]);

  await session.submit("/talk man Who are you?");
  assert.deepEqual(cell("village-square")?.people, ["P"]);

  await session.submit("/go east");
  assert.deepEqual(session.map.cells.map((c) => [c.id, c.here, c.people]), [
    ["village-square", false, []],
    ["forest-edge", true, []],
  ]);
});

test("going down to the cellar shows only the cellar's level, and coming back up shows the street again", async () => {
  const { session } = setup();
  await session.start();
  await session.submit("/go inn");
  const ids = () => session.map.cells.map((c) => c.id);
  assert.deepEqual(ids(), ["village-square", "hollow-lantern-inn"]);
  assert.deepEqual(session.map.cells[1].stairs, { up: false, down: true });

  await session.submit("/go down");
  assert.equal(session.map.level, -1);
  assert.deepEqual(ids(), ["inn-cellar"]);
  assert.deepEqual(session.map.cells[0].stairs, { up: true, down: false });
  assert.deepEqual(session.map.links, [], "no lines to the level above");

  await session.submit("/go up");
  assert.deepEqual([session.map.level, ids()], [0, ["village-square", "hollow-lantern-inn"]]);
});

test("/new makes a character, then restarts the campaign with them", async () => {
  const { session, store } = setup();
  await session.start();
  await session.submit("/go east");

  const prompt = await session.submit("/new");
  assert.match(prompt.lines.at(-1)!.text, /name\?/);
  await session.submit("Ash Thorne");
  await session.submit("she");
  assert.match((await session.submit("might 6 wits 2 grace 1 charisma 2")).lines[0].text, /That's 11 points/);
  assert.match((await session.submit("7 1 1 1")).lines[0].text, /must be 1–6/);
  assert.match((await session.submit("/look")).lines[0].text, /Finish making your character/);
  const summary = await session.submit("cha 1 might 5 wits 3 grace 1");
  assert.equal(summary.lines[0].text, "Ash Thorne (she/her): might 5 (+2), wits 3 (+1), grace 1 (−1), charisma 1 (−1). HP 10.");
  assert.equal(session.scene.location.id, "forest-edge", "the old game carries on until the new one starts");

  const begun = await session.submit("yes");
  assert.equal(begun.reset, true);
  assert.equal(session.scene.location.id, "village-square");
  assert.deepEqual(
    [session.scene.character.name, session.scene.character.pronouns, session.scene.character.stats],
    ["Ash Thorne", "she/her", { might: 5, wits: 3, grace: 1, charisma: 1 }],
  );
  assert.equal((await store.load("test"))?.state.character.name, "Ash Thorne");
});

test("/cancel abandons a new character and keeps the current game", async () => {
  const { session } = setup();
  await session.start();
  await session.submit("/go east");
  await session.submit("/new");
  await session.submit("Ash");
  assert.equal((await session.submit("/cancel")).lines[0].text, "Back to your game.");
  assert.equal(session.scene.character.name, "Wren");
  assert.equal(session.scene.location.id, "forest-edge");
});

test("a quest completes when its definition of done holds, and pays out its reward", async () => {
  const { session } = setup(() => "Ah.");
  await session.start();
  const lantern = () => session.scene.quests.find((q) => q.id === "missing-lantern")?.status;

  // The key is buried in the Depths: search, then take it.
  for (const step of ["/go east", "/go east", "/search"]) await session.submit(step);
  for (const step of ["/take key", "/go west", "/go west", "/go inn"]) await session.submit(step);
  assert.equal(lantern(), "active", "followed the trail, but Marta doesn't have her key back yet");

  const gave = await session.submit("/give key to the innkeeper");
  assert.deepEqual(gave.lines.map((l) => l.text), [
    "You give the innkeeper an iron key.",
    "Quest complete: The Missing Lantern. Reward: 100 XP, 5 silver pennies.",
    "You have enough experience to reach level 2: /levelup <stat>.",
  ]);
  assert.equal(lantern(), "completed");
  assert.equal(session.scene.character.xp, 100);
  assert.ok(session.scene.character.inventory.includes("5 silver pennies"));
});

test("experience is spent to level up, raising a stat and max HP, without costing an action", async () => {
  const store = new InMemoryStore();
  const { session } = setup(undefined, store);
  await session.start();
  assert.match((await session.submit("/levelup wits")).lines[0].text, /Level 2 needs 100 XP; you have 0/);

  // As if earned from quests.
  const saved = (await store.load("test"))!;
  saved.state.character.xp = 130;
  await store.commitTurn(saved.state, { turn: 1, input: "", events: [], output: [] });
  const resumed = setup(undefined, store).session;
  await resumed.start();

  assert.match((await resumed.submit("/levelup charm")).lines[0].text, /No stat called "charm"/);
  const levelled = await resumed.submit("/levelup wits");
  assert.equal(levelled.lines[0].text, "You reach level 2: wits rises to 4, max HP to 12.");
  const { character } = resumed.scene;
  assert.deepEqual([character.level, character.xp, character.hp, character.maxHp], [2, 30, 12, 12]);
  assert.equal(resumed.status.actionsLeft, 3);
  assert.equal(resumed.status.nextLevelXp, 200);
  assert.equal((await store.load("test"))?.state.character.level, 2, "saved");
});

const lie = JSON.stringify({
  kind: "talk",
  npc: "the old man",
  message: "I'm the magistrate's nephew.",
  check: { stat: "charisma", why: "pass themselves off as the magistrate's nephew" },
});

test("risky attempts are rolled in secret: the narrator learns the outcome, the player only sees the story", async () => {
  const { session, llm } = setup((req) => (req.json ? lie : "*The old man squints.* Never heard of you."), undefined, dice(1, 1));
  await session.start();
  const result = await session.submit("I tell him I'm the magistrate's nephew");
  assert.deepEqual(result.lines.map((l) => l.text), ["*The old man squints.* Never heard of you."]);

  const prompt = llm.requests.at(-1)!.messages.map((m) => m.content).join("\n");
  assert.match(prompt, /trying to pass themselves off as the magistrate's nephew\. It fails badly/);
  assert.match(prompt, /Never mention dice/);
  assert.doesNotMatch(prompt, /total|rolled|\bdie\b/);
});

test("a partial success fools them for now; a few turns later they realise, and remember", async () => {
  const store = new InMemoryStore();
  // A best die of 4, +1 for charisma 3, is a partial success; the complication comes due two turns later.
  const { session, llm } = setup((req) => (req.json ? lie : "Well, well."), store, dice(4, 1));
  await session.start();
  await session.submit("I tell him I'm the magistrate's nephew");
  assert.match(llm.requests.at(-1)!.messages[1].content, /It works on you/);
  assert.equal((await store.load("test"))?.state.complications.length, 1);

  // Twenty minutes later: the first turn is spent still talking (six seconds), the next two ten minutes each.
  const realised = async () =>
    (await store.load("test"))!.memories.filter((m) => m.npcId === "old-pell" && /Realised/.test(m.text));
  await session.submit("/wait");
  await session.submit("/wait");
  assert.equal((await realised()).length, 0, "not yet");
  await session.submit("/wait");
  const [memory] = await realised();
  assert.match(memory.text, /Realised the stranger got the better of them: when the stranger tried to pass themselves off/);
  assert.deepEqual((await store.load("test"))?.state.complications, []);
});

test("a partial success at a place goes wrong there later, and the place stays changed", async () => {
  const fix = JSON.stringify({ kind: "act", action: "wedge the well's broken winch", check: { stat: "wits", why: "jam the well's winch so it holds" } });
  const surfaced = JSON.stringify({ narration: "With a crack, the winch's wedge splits.", lasting: "The well's winch hangs broken." });
  const { session } = setup(
    (req) => (req.json ? (req.messages[1].content.includes("hidden flaw") ? surfaced : fix) : "It holds."),
    undefined,
    dice(4, 1),
  );
  await session.start();
  await session.submit("I jam the winch");
  await session.submit("/go east");
  await session.submit("/wait"); // turn 2
  await session.submit("/wait"); // turn 3: due, but Wren is away
  const back = await session.submit("/go west");
  assert.ok(back.lines.some((l) => l.text === "With a crack, the winch's wedge splits."));
  assert.match(describeScene(session.scene), /Changed: The well's winch hangs broken\./);
});

test("pushing spends a drive for a third die; with none left, the roll goes ahead without it", async () => {
  const store = new InMemoryStore();
  // Three dice per push: 1, 1 and then a 6 that only a pushed roll gets.
  const { session, llm } = setup((req) => (req.json ? lie : "Hm."), store, dice(1, 1, 6, 1, 1, 6, 1, 1, 6));
  await session.start();

  const first = await session.submit("/push I tell him I'm the magistrate's nephew");
  assert.equal(first.lines[0].text, "(You push yourself. Drive left: 1.)");
  assert.match(llm.requests.at(-1)!.messages[1].content, /It works on you/, "the best of 1, 1, 6");
  const record = (await store.load("test"))!.recent.at(-1)!;
  assert.ok(record.events.some((e) => e.type === "checked" && e.check.pushed && e.check.dice.length === 3));

  await session.submit("/push I tell him I'm the magistrate's nephew");
  assert.equal(session.status.drive, 0);
  const third = await session.submit("/push I tell him I'm the magistrate's nephew");
  assert.equal(third.lines[0].text, "(You've no drive left to push with.)");
  assert.match(llm.requests.at(-1)!.messages[1].content, /It fails badly/, "two dice: 1 and 1");
});

test("there's no drive to spend on something that needs no roll", async () => {
  const { session } = setup((req) => (req.json ? '{"kind":"look"}' : "Rain."));
  await session.start();
  const result = await session.submit("/push look around");
  assert.equal(result.lines[0].text, "(Nothing here calls for pushing; you keep your drive.)");
  assert.equal(session.status.drive, 2);
});

test("asking to take several things takes one, and says so", async () => {
  const { session } = setup();
  await session.start();
  await session.submit("/go east");
  await session.submit("/go east");
  await session.submit("/search"); // the key is buried here
  const taken = await session.submit("/take hook and key");
  assert.deepEqual(taken.lines.map((l) => l.text), [
    "You take the hook on a stick.",
    "(You can only pick up one thing at a time. The iron key is still here.)",
  ]);
  assert.ok(!session.scene.character.inventory.includes("an iron key"));
  assert.equal(session.status.actionsLeft, 2);
});

test("sleeping passes the night: the player wakes at 07:00, rested, and the world has moved on", async () => {
  const { session, llm } = setup((req) => (req.json ? '{"kind":"sleep"}' : "You sleep."));
  await session.start();
  await session.submit("/go inn");
  await session.submit("/talk innkeeper Good night.");
  const woke = await session.submit("I find a corner and sleep");
  assert.equal(woke.lines.at(-1)?.text, "— Turn 2 —");
  assert.deepEqual(session.status.time, { day: 2, minutes: 420, phase: "morning" });
  assert.equal(session.status.actionsLeft, 3);
  assert.match(llm.requests.at(-1)!.messages[1].content, /wakes rested, now: day 2, morning \(07:00\)/);

  // Everyone the player talks to afterwards knows it's morning.
  await session.submit("/talk innkeeper Morning.");
  assert.match(llm.requests.at(-1)!.messages[1].content, /It is day 2, morning \(07:\d0\)/);
});

test("searching the cellar turns up the ledger, which can then be taken; the narrator never invents a find", async () => {
  const { session, llm } = setup((req) => (req.json ? '{"kind":"search","where":"behind the crates"}' : "Dust."));
  await session.start();
  await session.submit("/go inn");
  await session.submit("/go down");
  assert.ok(!session.scene.items.includes("ledger book"));

  await session.submit("I rummage behind the crates");
  assert.match(llm.requests.at(-1)!.messages[1].content, /finds a ledger book \(it was fallen behind a few of the crates\).*letting the forest return/);
  assert.ok(session.scene.items.includes("ledger book"));
  await session.submit("/take ledger");
  assert.ok(session.scene.character.inventory.includes("ledger book"));

  await session.submit("I search behind the crates again");
  assert.match(llm.requests.at(-1)!.messages[1].content, /finds nothing\. Don't invent anything/);
});

test("an older save gets the hidden items it never had, without hiding what the player has already seen", async () => {
  // A save from before hidden items: no hiddenItems, no cellar, and the key lying in plain sight in the Depths.
  const oldSave = async (visited: string[]) => {
    const store = new InMemoryStore();
    const state = world.newGame("test");
    const { hiddenItems: _, ...old } = state;
    delete old.locationItems["inn-cellar"];
    old.locationItems["forest-depths-1"].push("an iron key");
    await store.commitTurn({ ...old, visited } as typeof state, { turn: 1, input: "", events: [], output: [] });
    const session = setup(undefined, store).session;
    await session.start();
    await session.submit("/look"); // saves the migrated state
    return { session, saved: async () => (await store.load("test"))!.state };
  };

  const { session: fresh, saved } = await oldSave(["village-square"]);
  const before = await saved();
  await fresh.submit("/go inn");
  await fresh.submit("/go down");
  assert.deepEqual(fresh.scene.items, [CRATES], "the new cellar has its items, the ledger hidden");
  assert.match((await fresh.submit("/search")).lines[0].text, /You search, and find a ledger book/);
  // Wren never went to the Depths, so the key there is hidden again.
  const depths = (state: GameState) => [
    state.locationItems["forest-depths-1"].includes("an iron key"),
    state.hiddenItems["forest-depths-1"],
  ];
  assert.deepEqual(depths(before), [false, ["an iron key"]]);

  // Had Wren been there and seen it, it stays in sight.
  const seen = await oldSave(["village-square", "forest-edge", "forest-depths-1"]);
  assert.deepEqual(depths(await seen.saved()), [true, []]);
});

test("putting something down needs no roll: it just leaves the inventory and lies here", async () => {
  const drop = JSON.stringify({ kind: "drop", item: "crates" });
  const { session, llm } = setup((req) => (req.json ? drop : "Done."));
  await session.start();
  for (const step of ["/go inn", "/go down", "/take the crates", "/go up", "/go out"]) await session.submit(step);
  assert.ok(session.scene.character.inventory.includes(CRATES));

  await session.submit("drop the crates to ease my load");
  assert.ok(!session.scene.character.inventory.some((i) => /crate/.test(i)));
  assert.ok(session.scene.items.includes(CRATES));
  const prompt = llm.requests.findLast((r) => r.messages[1]?.content.includes("Outcome decided"))!.messages[1].content;
  assert.ok(prompt.includes(`put down ${CRATES}; it now lies here`));
  assert.doesNotMatch(prompt, /attempt to/);
});

test("a place the player has been can be reached in one go, a step per action, across turns", async () => {
  const { session, llm } = setup((req) => (req.json ? '{"kind":"move","direction":"Edge of the Thornwood"}' : "You walk."));
  await session.start();
  for (const step of ["/go inn", "/go down", "/go up", "/go out", "/go east"]) await session.submit(step);
  await session.submit("/go west");
  assert.deepEqual(session.status.actionsLeft, 3, "turn 2, all actions left");

  // Back down to the cellar: square → inn → cellar, three steps, three actions.
  const there = await session.submit("/go cellar");
  assert.equal(session.scene.location.id, "inn-cellar");
  assert.equal(there.lines[0].text, "You make your way there by way of The Hollow Lantern.");
  assert.deepEqual([session.status.turn, session.status.actionsLeft], [3, 1]);

  // And by free text, back out to the woods: three steps with one action left, so two into the next turn.
  await session.submit("head back to the edge of the woods");
  assert.equal(session.scene.location.id, "forest-edge");
  assert.deepEqual([session.status.turn, session.status.actionsLeft], [4, 1]);
  const narration = llm.requests.findLast((r) => r.messages[1]?.content.includes("Outcome decided"))!.messages[1].content;
  assert.match(narration, /made their way from Hollow Lantern Inn's Cellar by way of The Hollow Lantern, then Brackenford Square to Edge of the Thornwood/);
});

test("a place the player has never been can't be travelled to", async () => {
  const { session } = setup();
  await session.start();
  assert.match((await session.submit("/go depths")).lines[0].text, /can't go/);
  assert.match((await session.submit("/go square")).lines[0].text, /already at Brackenford Square/);
});
