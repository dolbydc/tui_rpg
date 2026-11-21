import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONTENT_DIR } from "../config.js";
import type { MapView } from "../engine/api.js";
import { createGame } from "../engine/create.js";
import { mapShapes, pageOf } from "./page.js";

test("the page shows the character, turn, things and quests as the panels need them", async () => {
  const game = await createGame({ contentDir: DEFAULT_CONTENT_DIR, storage: "memory", sqliteFile: "", llm: "mock", ollamaUrl: "", ollamaModel: "" });
  await game.open("hollow-lantern", "new");
  for (const answer of ["Ash", "they", "3 3 2 2"]) await game.submit(answer);
  assert.deepEqual(pageOf((await game.submit("3 3 2 2")).view), { title: "The Hollow Lantern" }, "no panels while making a character");
  const page = pageOf((await game.submit("yes")).view);
  await game.close();

  const player = page.player!;
  assert.deepEqual(player.place, { name: "Brackenford Square" });
  assert.deepEqual(player.people, [{ label: "The old man", appearance: "a hunched old man in a sodden wool coat" }]);
  assert.deepEqual(player.character.stats, [
    { name: "charisma", value: 2, bonus: "±0" },
    { name: "grace", value: 2, bonus: "±0" },
    { name: "might", value: 3, bonus: "+1" },
    { name: "wits", value: 3, bonus: "+1" },
  ]);
  assert.equal(player.character.canLevelUp, false);
  assert.deepEqual(player.time, { day: "Day 1 · night", clock: "20:00" });
  assert.deepEqual(player.turn, { number: 1, actionsLeft: 3, actionsPerTurn: 3, drive: 2, drivePerQuest: 2 });
  assert.deepEqual(player.inventory, ["traveler's cloak", "3 copper coins"]);
  assert.deepEqual(player.quests.map((q) => q.done), [false, false]);

  const [square] = player.map.places;
  assert.equal(square.label, "Square");
  assert.deepEqual(square.people, ["@", "?"], "you, and someone you haven't met");
  assert.ok(player.map.links.length > 0 && player.map.links.every((l) => l.stub), "exits lead off to places not yet seen");
});

test("pictures become file URLs, and one on its way says so", () => {
  const view = {
    title: "T",
    player: {
      place: { id: "a", name: "A", drawing: true },
      people: [{ id: "p", label: "the smith", appearance: "a big woman", known: false, image: "/art/smith one.png" }],
      character: { name: "Ash", pronouns: "they/them", hp: 3, maxHp: 10, level: 1, xp: 120, stats: {}, inventory: [] },
      quests: [],
      map: { level: -1, cells: [], links: [] },
      status: { turn: 1, actionsLeft: 1, actionsPerTurn: 3, nextLevelXp: 100, drive: 0, drivePerQuest: 2, time: { day: 2, minutes: 7 * 60 + 5, phase: "morning" as const } },
    },
  };
  const player = pageOf(view as never).player!;
  assert.deepEqual(player.place, { name: "A", drawing: true });
  assert.deepEqual(player.people, [{ label: "The smith", appearance: "a big woman", url: "file:///art/smith%20one.png" }]);
  assert.equal(player.character.canLevelUp, true);
  assert.deepEqual(player.time, { day: "Day 2 · morning", clock: "07:05" });
  assert.equal(player.map.level, "1 below ground");
});

test("a big map is shown round the player, three places each way, and all of it opened full-size", () => {
  const cell = (x: number, y: number, here = false) => ({
    id: `${x},${y}`, label: `${x},${y}`, position: { x, y, z: 0 }, here, people: [], items: 0, stairs: { up: false, down: false },
  });
  const row = [0, 1, 2, 3, 4, 5].map((x) => cell(x, 0, x === 4));
  const map: MapView = { level: 0, cells: row, links: [] };
  const [x, , width] = mapShapes(map).viewBox.split(" ").map(Number);
  // Boxes 150 wide, 60 apart, 28 of margin. Three places across, centred on the fifth but not past the last.
  assert.equal(width, 3 * 150 + 2 * 60 + 2 * 28);
  assert.equal(x, 5 * 210 + 150 - (3 * 150 + 2 * 60) - 28, "kept inside the map's right edge");
  assert.equal(mapShapes(map, false).viewBox, `-28 -28 ${5 * 210 + 150 + 56} ${112 + 56}`, "opened full-size, all of it");
  const small = mapShapes({ level: 0, cells: [cell(0, 0, true), cell(1, 0)], links: [] });
  assert.equal(small.viewBox, "-28 -28 416 168", "a small map is shown whole");
});

test("the minds, when the engine sends them: the player and narrator first, each NPC where they are", () => {
  const view = {
    title: "T",
    player: {
      place: { id: "a", name: "A" },
      people: [{ id: "p", label: "the smith", appearance: "a big woman", known: false, talking: true, speaking: true }],
      character: { name: "Ash", pronouns: "they/them", hp: 3, maxHp: 10, level: 1, xp: 0, stats: {}, inventory: [] },
      quests: [],
      map: { level: 0, cells: [], links: [] },
      status: { turn: 1, actionsLeft: 1, actionsPerTurn: 3, nextLevelXp: 100, drive: 0, drivePerQuest: 2, time: { day: 1, minutes: 0, phase: "night" as const } },
    },
    minds: {
      agents: [
        { id: "p", name: "Bryn", placeId: "a", placeName: "A", companion: false, image: "/art/bryn.png" },
        { id: "q", name: "Cole", placeId: "b", placeName: "B", companion: false },
      ],
      links: [{ a: "p", b: "player", weight: 2 }],
    },
  };
  const player = pageOf(view as never).player!;
  assert.deepEqual(player.people[0], { label: "The smith", appearance: "a big woman", talking: true, speaking: true });
  assert.deepEqual(
    player.minds!.agents.map((a) => [a.id, a.role, a.place, a.withPlayer, a.url]),
    [
      ["player", "player", "A", true, undefined],
      ["narrator", "narrator", undefined, false, undefined],
      ["p", "npc", "A", true, "file:///art/bryn.png"],
      ["q", "npc", "B", false, undefined],
    ],
  );
  assert.deepEqual(player.minds!.links, view.minds.links);
  assert.equal(pageOf({ ...view, minds: undefined } as never).player!.minds, undefined, "none unless the engine sends them");
});
