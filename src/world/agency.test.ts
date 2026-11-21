import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAMPAIGN_DIR } from "../config.js";
import type { GameState, NpcPlan } from "../domain/types.js";
import { describeRevisit, revisitOutcome } from "../narrative/describe.js";
import { parsePlan } from "../narrative/engine.js";
import { deciders, enact, situation } from "./agency.js";
import { WorldEngine } from "./engine.js";
import { loadWorld } from "./loader.js";

// Brackenford: the inn's cellar – the inn – the square – the forest's edge – the forest depths, in a line.
// Old Pell starts in the square; Marta keeps the inn.
const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
const start = () => world.newGame("t");
const at = (state: GameState, locationId: string): GameState => ({ ...state, locationId });
/** One of the plans, without who and what they're seen doing (Omit over each member of the union). */
type Action = NpcPlan extends infer P ? (P extends unknown ? Omit<P, "npcId" | "doing"> : never) : never;
const plan = (npcId: string, rest: Action & { doing?: string }): NpcPlan => ({ npcId, doing: "", ...rest }) as NpcPlan;

test("coming back to a place, what's changed since is told, and only that", () => {
  // Seen at the start, then: the notice taken down, a fire, Pell gone off, Marta come out, and night falls.
  const seen = world.snapshot(start());
  const later: GameState = {
    ...seen,
    elapsed: seen.elapsed + 12 * 3600,
    locationItems: { ...seen.locationItems, "village-square": ["bucket"] },
    locationNotes: { "village-square": ["The well's roof is a charred ruin, still smoking."] },
    npcPlaces: { "old-pell": "forest-edge", marta: "village-square" },
  };
  const since = world.revisit(later)!;
  assert.equal(since.ago, 12 * 3600);
  assert.deepEqual(since.itemsGone, ["torn notice"]);
  assert.deepEqual(since.itemsNew, ["bucket"]);
  assert.deepEqual(since.changes, ["The well's roof is a charred ruin, still smoking."]);
  assert.deepEqual([since.arrived.map((n) => n.id), since.gone.map((n) => n.id)], [["marta"], ["old-pell"]]);

  const scene = world.scene(later);
  assert.equal(
    describeRevisit(scene).split("\n").slice(0, 2).join("\n"),
    "Brackenford Square\nSince you were last here: The well's roof is a charred ruin, still smoking. Gone: a torn notice. " +
      "New here: a bucket. Here now who weren't before: the innkeeper. No longer here: the old man. It was night when you were last here; now it's morning.",
  );
  const told = revisitOutcome(scene);
  assert.match(told, /has been at Brackenford Square before, about 12 hours ago, and knows it: don't describe the place again/);
  assert.match(told, /charred ruin/);
});

test("a place just as it was is told as much, and a place never seen has nothing to compare", () => {
  const seen = world.snapshot(start());
  assert.equal(describeRevisit(world.scene(seen)).split("\n")[1], "Just as you left it.");
  assert.match(revisitOutcome(world.scene(seen)), /Nothing about it has changed since/);
  assert.equal(world.scene(at(seen, "hollow-lantern-inn")).since, undefined);
});

test("an NPC going somewhere crosses a few places a turn, and is only told of as they come and go", () => {
  const state = at(start(), "inn-cellar");
  const { state: next, lines } = enact(world, { ...state, npcPlaces: { marta: "inn-cellar" } }, [
    plan("marta", { action: "go", to: "forest-depths-1", doing: "Marta hurries out." }),
  ]);
  // Cellar → inn → square → forest's edge: three steps; the depths are a turn further.
  assert.equal(world.npcLocation(world.npc("marta"), next), "forest-edge");
  assert.deepEqual(lines, [], "movements are announced by the world, not by the plan");
});

test("an NPC can go looking for the player", () => {
  // The inn → the square → the forest's edge → the depths: three steps, there in a turn.
  const state = at(start(), "forest-depths-1");
  const { state: next } = enact(world, state, [plan("marta", { action: "seek_player" })]);
  assert.equal(world.npcLocation(world.npc("marta"), next), "forest-depths-1");
});

test("an NPC can change a place for good; the player sees it if there, and so do sharp-eyed NPCs", () => {
  const state = at(start(), "hollow-lantern-inn");
  const fire = plan("marta", { action: "change", change: "The bar is scorched black.", doing: "Marta hurls a lamp at the bar." });
  const { state: next, lines, memories } = enact(world, { ...state, npcPlaces: { "old-pell": "hollow-lantern-inn" } }, [fire]);
  assert.deepEqual(next.locationNotes["hollow-lantern-inn"], ["The bar is scorched black."]);
  assert.deepEqual(lines, [{ kind: "narration", text: "Marta hurls a lamp at the bar." }]);
  assert.deepEqual(
    memories.map((m) => `${m.npcId}: ${m.text}`),
    ["marta: Marta hurls a lamp at the bar. (at The Hollow Lantern)", "old-pell: Saw at The Hollow Lantern: Marta hurls a lamp at the bar."],
  );

  // Elsewhere, the player doesn't see it happen; they'll find it when they're next there.
  const away = enact(world, at(start(), "forest-edge"), [fire]);
  assert.deepEqual(away.lines, []);
  assert.deepEqual(away.state.locationNotes["hollow-lantern-inn"], ["The bar is scorched black."]);
});

test("seeking someone out to talk puts them first in line; someone who's gone can't be", () => {
  const together = { ...start(), npcPlaces: { marta: "village-square" } };
  assert.deepEqual(enact(world, together, [plan("marta", { action: "talk", with: "old-pell" })]).talks, [["marta", "old-pell"]]);
  assert.deepEqual(enact(world, start(), [plan("marta", { action: "talk", with: "old-pell" })]).talks, []);
});

test("a companion stays with the player unless they choose to leave; then they stay put, or go", () => {
  const along = { ...start(), companions: ["old-pell"] };
  const wandered = enact(world, along, [plan("old-pell", { action: "go", to: "forest-edge" })]);
  assert.deepEqual(wandered.state.companions, ["old-pell"], "a companion doesn't just wander off");

  const left = enact(world, along, [plan("old-pell", { action: "leave_player", to: "hollow-lantern-inn" })]);
  assert.deepEqual(left.state.companions, []);
  assert.equal(world.npcLocation(world.npc("old-pell"), left.state), "hollow-lantern-inn");

  assert.deepEqual(enact(world, start(), [plan("old-pell", { action: "leave_player" })]).state.companions, undefined);
});

test("the person the player is talking with doesn't decide anything: they're busy", () => {
  const talking: GameState = { ...start(), conversation: { npcId: "old-pell", idleActions: 0 } };
  assert.deepEqual(deciders(world, talking).map((n) => n.id), ["marta"]);
  const { state } = enact(world, talking, [plan("old-pell", { action: "go", to: "forest-edge" })]);
  assert.equal(world.npcLocation(world.npc("old-pell"), state), "village-square");
});

test("an NPC's situation: where they are, who's there, the player by name only once they know it", () => {
  const view = situation(world, start(), [], world.npc("old-pell"));
  assert.equal(view.place.id, "village-square");
  assert.deepEqual(view.stranger, { pronouns: world.world.start.character.pronouns });
  assert.equal(view.companion, false);
  assert.equal(situation(world, at(start(), "forest-edge"), [], world.npc("old-pell")).stranger, undefined);
});

test("the model's choice is matched to places and people, and nonsense is dropped", () => {
  const view = situation(world, { ...start(), npcPlaces: { marta: "village-square" } }, [], world.npc("old-pell"));
  const parse = (json: object) => parsePlan(JSON.stringify(json), view);
  assert.deepEqual(parse({ action: "go", to: "the inn", doing: "Pell shuffles off." }), {
    npcId: "old-pell",
    doing: "Pell shuffles off.",
    action: "go",
    to: "hollow-lantern-inn",
  });
  assert.deepEqual(parse({ action: "talk", with: "Marta", doing: "" }), { npcId: "old-pell", doing: "", action: "talk", with: "marta" });
  assert.equal(parse({ action: "go", to: "the moon", doing: "" })?.action, "stay", "nowhere to go: they stay");
  assert.equal(parse({ action: "go", to: "Brackenford Square", doing: "" })?.action, "stay", "already there");
  assert.equal(parse({ action: "change", change: "", doing: "" })?.action, "stay");
  assert.equal(parse({ action: "fly", doing: "" }), undefined);
  assert.equal(parsePlan("not json", view), undefined);
});
