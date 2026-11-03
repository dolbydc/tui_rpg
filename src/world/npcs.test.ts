import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAMPAIGN_DIR } from "../config.js";
import type { GameState, Intent, NpcMemory } from "../domain/types.js";
import { parseExchange } from "../narrative/engine.js";
import { ACTIONS_PER_TURN, takeOne, WorldEngine } from "./engine.js";
import { loadWorld } from "./loader.js";
import { knowsPlayerName, newMemory } from "./memory.js";
import { observe } from "./perception.js";
import { applyExchange, canShare, findExchange, shareable } from "./sharing.js";


// Old Pell (perception 3, open) sits in the square on turns 0–2 and is at the inn on turns 3–4.
// Marta Vell (perception 4, guarded, trusts Pell) is always at the inn.
async function setup() {
  const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
  return { world, pell: world.npc("old-pell"), marta: world.npc("marta") };
}

function play(world: WorldEngine, state: GameState, intent: Intent, known: NpcMemory[] = []) {
  const resolution = world.resolve(intent, state);
  assert.ok(resolution.ok, resolution.ok ? "" : resolution.reason);
  const after = world.act(state, intent, resolution);
  return { before: state, after, intent, events: resolution.events, resolution, input: "", known };
}

/** A moment at normal pace: turn n is (n − 1) ten-minute turns in. */
const when = (turn: number) => ({ turn, elapsed: (turn - 1) * 600 });
const at = (turn: number) => ({ ...when(turn), routineDelay: {} });

const texts = (memories: NpcMemory[], npcId: string) => memories.filter((m) => m.npcId === npcId).map((m) => m.text);

test("NPCs follow their routines", async () => {
  const { world } = await setup();
  assert.deepEqual(world.npcsAt("village-square", at(2)).map((n) => n.id), ["old-pell"]);
  assert.deepEqual(world.npcsAt("hollow-lantern-inn", at(3)).map((n) => n.id), ["marta", "old-pell"]);
});

test("an observant NPC sees which way the player left", async () => {
  const { world } = await setup();
  const memories = observe(world, play(world, world.newGame("t"), { kind: "move", direction: "east" }));
  assert.deepEqual(texts(memories, "old-pell"), [
    "The stranger left Brackenford Square, heading east toward Edge of the Thornwood.",
  ]);
  assert.equal(memories[0].share, "public");
});

test("less observant NPCs notice less", async () => {
  const { world, pell } = await setup();
  pell.perception = 2;
  const turn = play(world, world.newGame("t"), { kind: "move", direction: "east" });
  assert.deepEqual(texts(observe(world, turn), "old-pell"), ["The stranger left Brackenford Square."]);

  pell.perception = 1;
  assert.deepEqual(observe(world, turn), []);
});

test("NPCs notice the player arriving and taking things", async () => {
  const { world } = await setup();
  const atSquare = world.newGame("t");
  const toInn = play(world, { ...atSquare, ...when(3) }, { kind: "move", direction: "inn" });
  assert.deepEqual(texts(observe(world, toInn), "marta"), ["The stranger arrived at The Hollow Lantern from Brackenford Square."]);

  const takeCup = play(world, toInn.after, { kind: "take", items: ["cup"] });
  assert.deepEqual(texts(observe(world, takeCup), "marta"), ["The stranger picked up the tin cup at The Hollow Lantern."]);
});

test("the NPC talked to remembers the conversation; only a sharp-eared bystander overhears it", async () => {
  const { world, pell, marta } = await setup();
  const atInn = { ...world.newGame("t"), locationId: "hollow-lantern-inn", ...when(3) };
  const talk = (npc: typeof pell) => {
    const turn = play(world, atInn, { kind: "talk", npc: npc.epithet, message: "Seen the lantern?" });
    return observe(world, { ...turn, dialogue: { npc, said: "Seen the lantern?", reply: "No." } });
  };

  const toPell = talk(pell);
  assert.equal(toPell.find((m) => m.npcId === "old-pell")?.kind, "conversation");
  assert.match(texts(toPell, "marta")[0], /^Overheard the stranger say to Old Pell/);

  // Pell's perception is too low to overhear Marta's conversations.
  const toMarta = talk(marta);
  assert.deepEqual(texts(toMarta, "old-pell"), []);
});

test("NPCs only learn the player's name when it's said in their hearing, and only once", async () => {
  const { world, pell, marta } = await setup();
  const atInn = { ...world.newGame("t"), locationId: "hollow-lantern-inn", ...when(3) };
  const say = (said: string, known: NpcMemory[] = []) => {
    const turn = play(world, atInn, { kind: "talk", npc: "old man", message: said }, known);
    return observe(world, { ...turn, input: said, dialogue: { npc: pell, said, reply: "Eh?" } });
  };

  assert.ok(!say("Evening.").some((m) => /name is/.test(m.text)));

  const introduced = say("Evening, I'm Wren.");
  assert.ok(knowsPlayerName("old-pell", introduced));
  assert.ok(knowsPlayerName("marta", introduced), "Marta overheard it");
  assert.equal(texts(introduced, "old-pell").at(-1), "The stranger's name is Wren.");
  assert.ok(!say("Wren again.", introduced).some((m) => /name is/.test(m.text)), "already known");

  // The name spreads like any other fact: Marta (who trusts Pell) can tell him once she knows it.
  const overheard = introduced.filter((m) => m.npcId === "marta");
  assert.ok(shareable(marta, pell, overheard).some((f) => f.text === "The stranger's name is Wren."));
});

test("giving an item moves one from the player to the NPC, who remembers it", async () => {
  const { world } = await setup();
  const atSquare = world.newGame("t");
  const give = play(world, atSquare, { kind: "give", item: "a copper coin", npc: "the old man" });
  assert.deepEqual(give.events, [{ type: "item_given", item: "copper coin", npcId: "old-pell" }]);
  assert.deepEqual(give.after.character.inventory, ["traveler's cloak", "2 copper coins"]);
  assert.deepEqual(give.after.npcItems, { "old-pell": ["copper coin"] });
  assert.deepEqual(texts(observe(world, give), "old-pell"), ["The stranger gave Old Pell a copper coin."]);

  assert.equal(world.resolve({ kind: "give", item: "sword", npc: "old man" }, atSquare).ok, false);
  assert.equal(world.resolve({ kind: "give", item: "cloak", npc: "innkeeper" }, atSquare).ok, false, "not here");
});

test("counted stacks split one at a time; other items are given whole", () => {
  assert.deepEqual(takeOne("3 copper coins"), { given: "copper coin", remaining: "2 copper coins" });
  assert.deepEqual(takeOne("2 copper coins"), { given: "copper coin", remaining: "1 copper coin" });
  assert.deepEqual(takeOne("1 copper coin"), { given: "copper coin" });
  assert.deepEqual(takeOne("leather boots"), { given: "leather boots" });
});

test("NPCs coming into or leaving the player's sight are reported", async () => {
  const { world } = await setup();
  const atSquare = world.newGame("t");
  const atInn = { ...atSquare, locationId: "hollow-lantern-inn" };
  const moves = (before: GameState, after: GameState) => world.npcMovements(before, after).map((m) => `${m.npc.id}:${m.kind}`);

  // Turn 2 → 3 Pell goes to the inn; turn 4 → 5 he goes back to the square.
  assert.deepEqual(moves({ ...atInn, ...when(2) }, { ...atInn, ...when(3) }), ["old-pell:arrived"]);
  assert.deepEqual(moves({ ...atSquare, ...when(2) }, { ...atInn, ...when(3) }), ["old-pell:followed"]);
  assert.deepEqual(moves({ ...atInn, ...when(4) }, { ...atInn, ...when(5) }), ["old-pell:left"]);
  assert.deepEqual(moves({ ...atSquare, ...when(2) }, { ...atSquare, ...when(3) }), ["old-pell:left"]);
  assert.deepEqual(moves({ ...atInn, ...when(0) }, { ...atInn, ...when(1) }), [], "nobody moves");
});

test("an NPC in conversation with the player pauses their routine until it ends", async () => {
  const { world } = await setup();
  const where = (state: GameState) => world.npcLocation(world.npc("old-pell"), state);
  const talk: Intent = { kind: "talk", npc: "old man", message: "And then?" };

  // Without talking, Pell goes to the inn on turn 3. Talking to him all through turn 2 keeps him in the square.
  let state = { ...world.newGame("t"), ...when(2) };
  for (let i = 0; i < ACTIONS_PER_TURN; i++) state = play(world, state, talk).after;
  assert.equal(state.turn, 3);
  assert.equal(where(state), "village-square");
  assert.deepEqual(state.conversation, { npcId: "old-pell", idleActions: 0 });

  // One action not addressing him (looking around) and the conversation goes on; a second and it's over.
  state = play(world, state, { kind: "look" }).after;
  assert.deepEqual(state.conversation, { npcId: "old-pell", idleActions: 1 });
  state = play(world, state, { kind: "look" }).after;
  assert.equal(state.conversation, undefined);
  // When the turn ends he picks his routine up where he left it: the inn, as he would have on turn 3.
  state = play(world, state, { kind: "wait" }).after;
  assert.equal(state.turn, 4);
  assert.equal(where(state), "hollow-lantern-inn");
});

test("walking away ends the conversation at once", async () => {
  const { world } = await setup();
  let state = { ...world.newGame("t"), ...when(2) };
  state = play(world, state, { kind: "talk", npc: "old man", message: "Hm." }).after;
  state = play(world, state, { kind: "move", direction: "east" }).after;
  assert.equal(state.conversation, undefined);
  // The conversation was over before the turn ended, so he keeps to his routine: off to the inn on turn 3.
  state = play(world, state, { kind: "wait" }).after;
  assert.equal(state.turn, 3);
  assert.equal(world.npcLocation(world.npc("old-pell"), state), "hollow-lantern-inn");
});

test("share levels: secrets never, trusted only to those trusted, public to anyone", async () => {
  const { pell, marta } = await setup();
  const stranger = { ...pell, id: "stranger", trusts: [] };
  assert.equal(canShare("secret", marta, pell), false);
  assert.equal(canShare("trusted", marta, pell), true);
  assert.equal(canShare("trusted", marta, stranger), false);
  assert.equal(canShare("public", pell, stranger), true);

  const fromMarta = shareable(marta, pell, []).map((f) => f.origin);
  assert.deepEqual(fromMarta, ["knowledge:marta:grandmother-warning"]);
  const fromPell = shareable(pell, marta, []).map((f) => f.origin);
  assert.deepEqual(fromPell, ["knowledge:old-pell:small-figure"]);
});

test("NPCs who meet exchange information once, then wait before talking again", async () => {
  const { world, pell, marta } = await setup();
  const sawPlayer = newMemory(pell, { turn: 1, kind: "witnessed", about: "player", text: "The stranger went east." });

  assert.equal(findExchange(world, [sawPlayer], at(2)), undefined, "not in the same place on turn 2");
  const candidate = findExchange(world, [sawPlayer], at(3));
  assert.ok(candidate);
  assert.deepEqual([candidate.a.id, candidate.b.id], ["marta", "old-pell"]);

  const exchanged = applyExchange(
    candidate,
    { aTells: candidate.aToB, bTells: candidate.bToA, summary: "They talk by the fire." },
    3,
  );
  const heardByMarta = exchanged.filter((m) => m.npcId === "marta" && m.kind === "heard");
  assert.deepEqual(heardByMarta.map((m) => m.text).sort(), [
    pell.knowledge[0].fact,
    "The stranger went east.",
  ].sort());
  // Marta is guarded, so what she hears she only passes on to people she trusts.
  assert.ok(heardByMarta.every((m) => m.share === "trusted" && m.source?.npcId === "old-pell"));

  const all = [sawPlayer, ...exchanged];
  assert.equal(findExchange(world, all, at(4)), undefined, "cooling down");
  assert.deepEqual(shareable(pell, marta, all), [], "nothing new to tell");
});

test("an exchange can only pass on what was offered", async () => {
  const { world } = await setup();
  const candidate = findExchange(world, [], at(3));
  assert.ok(candidate);
  const choice = parseExchange('{"a_tells_b":["A1","A7","secret"],"b_tells_a":["B1","B9"],"summary":"Hm."}', candidate);
  assert.deepEqual(choice.aTells, candidate.aToB.slice(0, 1));
  assert.deepEqual(choice.bTells, candidate.bToA.slice(0, 1));
  assert.deepEqual(parseExchange("garbage", candidate), { aTells: [], bTells: [], summary: "" });

  // Models sometimes quote the fact instead of its id.
  const quoted = JSON.stringify({ a_tells_b: [], b_tells_a: [`"${candidate.bToA[0].text.toUpperCase()}"`], summary: "" });
  assert.deepEqual(parseExchange(quoted, candidate).bTells, candidate.bToA.slice(0, 1));
});

test("on a journey, NPCs notice the player passing through where they are; a sneak that works goes unseen", async () => {
  const { world } = await setup();
  const { fixedDice } = await import("./checks.js");
  // Wren has been to the inn's cellar and the woods' edge; Pell sits in the square, which lies between them.
  const base = { ...world.newGame("t"), locationId: "forest-edge", visited: ["village-square", "hollow-lantern-inn", "inn-cellar", "forest-edge"] };
  const travel = (intent: Intent, rng = Math.random) => {
    const engine = new WorldEngine(world.world, rng);
    const resolution = engine.resolve(intent, base);
    assert.ok(resolution.ok, resolution.ok ? "" : resolution.reason);
    const events = [...resolution.events, ...engine.check(intent, resolution, base, "")];
    const after = engine.act(base, intent, { ...resolution, events });
    return { after, memories: observe(engine, { before: base, after, intent, events, input: "", known: [] }) };
  };

  const walk = travel({ kind: "move", direction: "cellar" });
  assert.equal(walk.after.locationId, "inn-cellar");
  assert.deepEqual(texts(walk.memories, "old-pell"), [
    "The stranger arrived at Brackenford Square from Edge of the Thornwood.",
    "The stranger left Brackenford Square, heading for The Hollow Lantern.",
  ]);
  assert.ok(texts(walk.memories, "marta").some((t) => /left The Hollow Lantern|arrived at The Hollow Lantern/.test(t)));

  const sneak: Intent = { kind: "move", direction: "cellar", check: { stat: "grace", why: "slip through unseen", stealth: true } };
  assert.deepEqual(travel(sneak, fixedDice(6, 6)).memories, [], "a good roll: nobody sees a thing");
  const caught = /Caught the stranger sneaking, trying to slip through unseen/;
  // Wren's grace is 2 (no bonus): a best die of 3 partly fails, of 1 fails.
  const seen = texts(travel(sneak, fixedDice(3, 1)).memories, "old-pell");
  assert.ok(seen.length && !seen.some((t) => caught.test(t)), "a partial failure: noticed, not as a sneak");
  const botched = texts(travel(sneak, fixedDice(1, 1)).memories, "old-pell");
  assert.ok(botched.some((t) => caught.test(t)), "a failure: caught sneaking");
});
