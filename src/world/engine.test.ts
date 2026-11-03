import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAMPAIGN_DIR } from "../config.js";
import type { Intent } from "../domain/types.js";
import { WorldEngine } from "./engine.js";
import { loadWorld, parseMarkdown } from "./loader.js";

const engine = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
/** How many crates the cellar starts with ("6 crates"), so tests follow the content. */
const CRATES = Number(/^\d+/.exec(engine.location("inn-cellar").items[0])![0]);

test("loads the sample campaign", () => {
  assert.equal(engine.world.title, "The Hollow Lantern");
  assert.equal(engine.world.start.locationId, "village-square");
  assert.deepEqual([...engine.world.npcs.keys()], ["marta", "old-pell"]);
});

test("parses frontmatter and body", () => {
  const doc = parseMarkdown("---\nname: Square\nexits:\n  north: inn\n---\nA muddy square.\n");
  assert.deepEqual(doc.data, { name: "Square", exits: { north: "inn" } });
  assert.equal(doc.body, "A muddy square.");
});

test("moves through a matching exit, by direction or destination name", () => {
  const state = engine.newGame("t");
  const byDirection = engine.resolve({ kind: "move", direction: "East" }, state);
  assert.deepEqual(byDirection, { ok: true, events: [{ type: "moved", from: "village-square", to: "forest-edge" }] });

  const byName = engine.resolve({ kind: "move", direction: "the hollow lantern" }, state);
  assert.ok(byName.ok);
  assert.equal(engine.apply(state, byName.events).locationId, "hollow-lantern-inn");
});

test("an exit echoed as the scene lists it still matches", () => {
  const atInn = { ...engine.newGame("t"), locationId: "hollow-lantern-inn" };
  const resolution = engine.resolve({ kind: "move", direction: "out (Brackenford Square)" }, atInn);
  assert.deepEqual(resolution, {
    ok: true,
    events: [{ type: "moved", from: "hollow-lantern-inn", to: "village-square" }],
  });
});

test("rejects an exit that doesn't exist", () => {
  const resolution = engine.resolve({ kind: "move", direction: "up" }, engine.newGame("t"));
  assert.equal(resolution.ok, false);
});

test("taking an item moves it into the inventory without mutating the old state", () => {
  const state = engine.newGame("t");
  const resolution = engine.resolve({ kind: "take", items: ["notice"] }, state);
  assert.ok(resolution.ok);

  const next = engine.apply(state, resolution.events);
  assert.ok(next.character.inventory.includes("torn notice"));
  assert.deepEqual(next.locationItems["village-square"], []);
  assert.deepEqual(state.locationItems["village-square"], ["torn notice"]);
});

test("a paraphrased name still finds the person meant", () => {
  const atInn = { ...engine.newGame("t"), turn: 1, locationId: "hollow-lantern-inn" };
  const talk = (npc: string, state = atInn) => {
    const r = engine.resolve({ kind: "talk", npc, message: "hi" }, state);
    return r.ok ? r.npc?.id : undefined;
  };
  assert.equal(talk("the barwoman"), "marta", "shares a word with her description");
  // Otherwise an unmatched name goes to whoever the player is already talking with.
  assert.equal(talk("the landlady"), undefined);
  assert.equal(talk("the landlady", { ...atInn, conversation: { npcId: "marta", idleActions: 0 } }), "marta");
});

test("only one thing is picked up at a time, and the player is told what's left", () => {
  const buried = { ...engine.newGame("t"), locationId: "forest-depths-1" };
  // The key is buried until searched for.
  assert.equal(engine.resolve({ kind: "take", items: ["the key"] }, buried).ok, false);
  const search = engine.resolve({ kind: "search" }, buried);
  assert.ok(search.ok);
  const depths = engine.apply(buried, search.events);
  assert.deepEqual(engine.resolve({ kind: "take", items: ["the hook", "the key"] }, depths), {
    ok: true,
    events: [{ type: "item_taken", item: "hook on a stick", locationId: "forest-depths-1" }],
    notes: ["(You can only pick up one thing at a time. The iron key is still here.)"],
  });
  const some = engine.resolve({ kind: "take", items: ["lantern", "key"] }, depths);
  assert.ok(some.ok && some.events[0].type === "item_taken" && some.events[0].item === "an iron key");
  assert.deepEqual(some.ok && some.notes, ["(You can only pick up one thing at a time.)"]);
  assert.equal(engine.resolve({ kind: "take", items: ["lantern"] }, depths).ok, false);
});

test("talking needs the NPC to be present", () => {
  const state = engine.newGame("t");
  const pell = engine.resolve({ kind: "talk", npc: "old man", message: "hi" }, state);
  assert.ok(pell.ok && pell.npc?.id === "old-pell");
  assert.equal(engine.resolve({ kind: "talk", npc: "innkeeper", message: "hi" }, state).ok, false);
});

test("quests load their definition of done and reward", () => {
  const lantern = engine.world.quests.get("missing-lantern");
  assert.deepEqual(lantern?.done, [
    { kind: "visited", locationId: "forest-depths-1" },
    { kind: "gave", item: "iron key", npcId: "marta" },
  ]);
  assert.deepEqual(lantern?.reward, { xp: 100, items: ["5 silver pennies"] });
});

test("a quest completes only once every condition holds", () => {
  const state = engine.newGame("t");
  assert.deepEqual(engine.questCompletions(state), []);
  const knowsOne = { ...state, knownNpcs: ["marta"] };
  assert.deepEqual(engine.questCompletions(knowsOne), []);
  const knowsBoth = { ...state, knownNpcs: ["marta", "old-pell"] };
  const events = engine.questCompletions(knowsBoth);
  assert.deepEqual(events, [{ type: "quest_completed", questId: "introductions", reward: { xp: 25, items: [] } }]);

  const after = engine.apply(knowsBoth, events);
  assert.equal(after.quests.find((q) => q.id === "introductions")?.status, "completed");
  assert.equal(after.character.xp, 25);
  assert.deepEqual(engine.questCompletions(after), [], "and only once");
});

test("item conditions ignore articles, case and counts", () => {
  const state = engine.newGame("t");
  const have = (inventory: string[], item: string) =>
    engine.holds({ kind: "have", item }, { ...state, character: { ...state.character, inventory } });
  assert.ok(have(["An Iron Key"], "iron key"));
  assert.ok(have(["3 copper coins"], "copper coin"));
  assert.ok(!have(["tin cup"], "iron key"));
  assert.ok(engine.holds({ kind: "gave", item: "iron key", npcId: "marta" }, { ...state, npcItems: { marta: ["an iron key"] } }));
});

test("a quest must say when it's done, in conditions the engine can check", async () => {
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const campaign = async (quest: string) => {
    const dir = await mkdtemp(path.join(tmpdir(), "quest-"));
    await mkdir(path.join(dir, "locations"));
    await mkdir(path.join(dir, "npcs"));
    await writeFile(path.join(dir, "locations", "room.md"), "---\nname: Room\n---\nA room.");
    await writeFile(
      path.join(dir, "world.md"),
      `---\ntitle: T\nstart: room\ncharacter:\n  name: X\n  hp: 5\nquests:\n  - id: q\n    title: Q\n    description: D\n${quest}---\nIntro.`,
    );
    return loadWorld(dir);
  };
  await assert.rejects(campaign(""), /"done" must list the conditions/);
  await assert.rejects(campaign("    done:\n      - find: lantern\n"), /unknown condition "find"/);
  await assert.rejects(campaign("    done:\n      - at: cellar\n"), /unknown location "cellar"/);
  await assert.rejects(campaign("    done:\n      - knows: nobody\n"), /unknown NPC "nobody"/);
  const ok = await campaign("    done:\n      - at: room\n");
  assert.deepEqual(ok.quests.get("q")?.reward, { xp: 0, items: [] });
});

test("a quest can start partway through, after another is done, and restores the player's drive", async () => {
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "quest-"));
  await mkdir(path.join(dir, "locations"));
  await mkdir(path.join(dir, "npcs"));
  await writeFile(path.join(dir, "locations", "room.md"), "---\nname: Room\nexits:\n  east: hall\n---\nA room.");
  await writeFile(path.join(dir, "locations", "hall.md"), "---\nname: Hall\nexits:\n  west: room\n---\nA hall.");
  await writeFile(
    path.join(dir, "world.md"),
    [
      "---",
      "title: T",
      "start: room",
      "character: {name: X, hp: 5}",
      "quests:",
      "  - {id: first, title: First, description: D, done: [{visited: hall}]}",
      "  - {id: second, title: Second, description: D, starts: [{completed: first}], done: [{at: room}]}",
      "---",
      "Intro.",
    ].join("\n"),
  );
  const world = new WorldEngine(await loadWorld(dir));
  let state = world.newGame("t");
  assert.deepEqual(state.quests.map((q) => q.status), ["active", "pending"]);
  state = { ...state, drive: 0 };

  assert.deepEqual(world.questStarts(state), [], "not until the first is done");
  state = world.apply(state, [{ type: "moved", from: "room", to: "hall" }]);
  state = world.apply(state, world.questCompletions(state));
  const started = world.questStarts(state);
  assert.deepEqual(started, [{ type: "quest_started", questId: "second" }]);
  state = world.apply(state, started);
  assert.deepEqual(state.quests.map((q) => q.status), ["completed", "active"]);
  assert.equal(state.drive, 2);
});

test("the clock: the campaign's start time plus the seconds elapsed; sleep lasts until 07:00", async () => {
  const { timeAt, secondsUntilWaking } = await import("./time.js");
  assert.equal(engine.world.start.time, 20 * 60);
  assert.deepEqual(timeAt(0, 1200), { day: 1, minutes: 1200, phase: "night" });
  assert.deepEqual(timeAt(4 * 3600, 1200), { day: 2, minutes: 0, phase: "night" });
  assert.deepEqual(timeAt(12 * 3600, 1200), { day: 2, minutes: 480, phase: "morning" });
  assert.equal(secondsUntilWaking(0, 1200), 11 * 3600, "20:00 → 07:00");
  assert.equal(secondsUntilWaking(0, 6 * 60 + 55), 300, "a few minutes before waking");
  assert.equal(secondsUntilWaking(0, 7 * 60), 24 * 3600, "just woken: the next morning");
});

test("a turn takes ten minutes, or six seconds in a conversation or a confrontation", () => {
  const state = engine.newGame("t");
  const turn = (intent: Intent, from = state) => {
    let s = from;
    for (let i = 0; i < 3; i++) {
      const r = engine.resolve(intent, s);
      assert.ok(r.ok);
      s = engine.act(s, intent, { ...r, events: [...r.events, ...engine.check(intent, r, s, "")] });
    }
    return s;
  };
  assert.equal(turn({ kind: "act", action: "whistle" }).elapsed, 600);
  assert.equal(turn({ kind: "talk", npc: "old man", message: "Hm?" }).elapsed, 6);
  const shove: Intent = { kind: "act", action: "shove him", check: { stat: "might", why: "shove him", target: "old man" } };
  assert.equal(turn(shove).elapsed, 6);
});

test("hidden items stay out of sight until searched for", async () => {
  const cellar = engine.location("inn-cellar");
  assert.deepEqual(cellar.hiddenItems.map((h) => h.item), ["ledger book"]);
  const state = { ...engine.newGame("t"), locationId: "inn-cellar" };
  assert.deepEqual(engine.scene(state).items, [`${CRATES} crates`]);

  const search = engine.resolve({ kind: "search" }, state);
  assert.ok(search.ok);
  assert.deepEqual(search.events, [{ type: "item_found", item: "ledger book", locationId: "inn-cellar" }]);
  const after = engine.apply(state, search.events);
  assert.deepEqual(engine.scene(after).items, [`${CRATES} crates`, "ledger book"]);
  assert.deepEqual(after.hiddenItems["inn-cellar"], []);
  const again = engine.resolve({ kind: "search" }, after);
  assert.ok(again.ok && again.events.length === 0, "nothing more to find");
});

test("searching in the wrong spot, without the right thing in hand, or failing the roll finds nothing", async () => {
  const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { fixedDice } = await import("./checks.js");
  const dir = await mkdtemp(path.join(tmpdir(), "hidden-"));
  await mkdir(path.join(dir, "locations"));
  await mkdir(path.join(dir, "npcs"));
  await writeFile(
    path.join(dir, "locations", "crypt.md"),
    [
      "---",
      "name: Crypt",
      "hidden_items:",
      "  - item: silver ring",
      "    hidden: buried under the loose flagstone",
      "    check: {stat: wits, why: spot the loose flagstone}",
      "  - item: ghost lamp",
      "    hidden: veiled by a glamour",
      "    needs: seeing stone",
      "---",
      "A crypt.",
    ].join("\n"),
  );
  await writeFile(path.join(dir, "world.md"), "---\ntitle: T\nstart: crypt\ncharacter: {name: X, hp: 5, stats: {wits: 3}}\n---\nIntro.");
  const world = await loadWorld(dir);
  const at = (faces: number[], inventory: string[] = []) => {
    const engine = new WorldEngine(world, fixedDice(...faces));
    const state = engine.newGame("t");
    return { engine, state: { ...state, character: { ...state.character, inventory } } };
  };
  const found = (faces: number[], where?: string, inventory?: string[]) => {
    const { engine, state } = at(faces, inventory);
    const intent: Intent = where ? { kind: "search", where } : { kind: "search" };
    const r = engine.resolve(intent, state);
    assert.ok(r.ok);
    return [...r.events, ...engine.check(intent, r, state, "")].flatMap((e) => (e.type === "item_found" ? [e.item] : []));
  };

  assert.deepEqual(found([6, 6]), ["silver ring"], "a good roll turns up the ring; the lamp needs the stone");
  assert.deepEqual(found([1, 1]), [], "a failed roll finds nothing");
  assert.deepEqual(found([6, 6], "under the flagstone"), ["silver ring"]);
  assert.deepEqual(found([6, 6], "behind the lamp", ["seeing stone"]), ["ghost lamp"], "only where they look");
  assert.deepEqual(found([6, 6], undefined, ["seeing stone"]), ["ghost lamp", "silver ring"]);
});

test("counted piles: one at a time or the lot, merging back into piles", async () => {
  const { addTo, removeFrom } = await import("./engine.js");
  const cellar = { ...engine.newGame("t"), locationId: "inn-cellar" };
  const take = (state: typeof cellar, item: string) => {
    const r = engine.resolve({ kind: "take", items: [item] }, state);
    assert.ok(r.ok);
    return engine.apply(state, r.events);
  };
  const one = take(cellar, "a crate");
  assert.deepEqual(one.locationItems["inn-cellar"], [`${CRATES - 1} crates`]);
  assert.ok(one.character.inventory.includes("crate"));
  const two = take(one, "crate");
  assert.deepEqual([two.locationItems["inn-cellar"], two.character.inventory.at(-1)], [[`${CRATES - 2} crates`], "2 crates"]);
  const all = take(two, "the crates");
  assert.deepEqual([all.locationItems["inn-cellar"], all.character.inventory.at(-1)], [[], `${CRATES} crates`]);

  // Putting one down, then the rest.
  const drop = (state: typeof cellar, item: string) => {
    const r = engine.resolve({ kind: "drop", item }, state);
    assert.ok(r.ok, r.ok ? "" : r.reason);
    return engine.apply(state, r.events);
  };
  const dropped = drop(all, "a crate");
  assert.deepEqual([dropped.locationItems["inn-cellar"], dropped.character.inventory.at(-1)], [["crate"], `${CRATES - 1} crates`]);
  const cleared = drop(dropped, "the crates");
  assert.deepEqual(cleared.locationItems["inn-cellar"], [`${CRATES} crates`]);
  assert.ok(!cleared.character.inventory.some((i) => /crate/.test(i)));
  assert.equal(engine.resolve({ kind: "drop", item: "crates" }, cleared).ok, false, "nothing left to drop");

  assert.deepEqual(addTo(["2 copper coins"], "copper coin"), ["3 copper coins"]);
  assert.deepEqual(addTo(["an iron key"], "an iron key"), ["2 iron keys"]);
  assert.deepEqual(addTo(["box"], "box"), ["2 boxes"]);
  assert.deepEqual(removeFrom(["3 boxes"], "box"), ["2 boxes"]);
  assert.deepEqual(removeFrom(["2 boxes"], "box"), ["1 box"]);
});
