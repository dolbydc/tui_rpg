import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONTENT_DIR } from "../config.js";
import { MockProvider } from "../llm/mock.js";
import { InMemoryStore } from "../storage/memory.js";
import { menuItems } from "../tui/menu.js";
import { WorldEngine } from "../world/engine.js";
import { loadWorld } from "../world/loader.js";
import { CampaignLibrary, LEGACY_SAVE, listCampaigns } from "./campaigns.js";

test("every campaign in content/ is offered, by title, and loads", async () => {
  const campaigns = await listCampaigns(DEFAULT_CONTENT_DIR);
  assert.deepEqual(
    campaigns.map((c) => [c.id, c.title]),
    [
      ["hollow-lantern", "The Hollow Lantern"],
      ["those-dark-places", "Those Dark Places"],
    ],
  );
  for (const campaign of campaigns) {
    const world = new WorldEngine(await loadWorld(campaign.dir));
    // Something to do from the first turn, and a place to start.
    assert.ok(world.world.start.quests.some((q) => q.status === "active"), campaign.id);
    assert.ok(world.scene(world.newGame(campaign.id)).exits.length, campaign.id);
  }
});

test("Those Dark Places spans four decks, administration above and the bore far below, each drawn on its own", async () => {
  const world = new WorldEngine(await loadWorld(`${DEFAULT_CONTENT_DIR}/those-dark-places`));
  const level = (id: string) => world.location(id).position.z;
  assert.deepEqual(
    ["dock-three", "concourse", "admin-deck", "ore-processing", "bore-access", "deep-bore"].map(level),
    [0, 0, 1, -1, -1, -2],
  );
});

test("a save from before campaigns could be chosen becomes The Hollow Lantern's", async () => {
  const store = new InMemoryStore();
  const world = new WorldEngine(await loadWorld(`${DEFAULT_CONTENT_DIR}/hollow-lantern`));
  await store.commitTurn({ ...world.newGame(LEGACY_SAVE.id), turn: 7 }, { turn: 7, input: "", events: [], output: [] });
  const library = await CampaignLibrary.load(DEFAULT_CONTENT_DIR, store, new MockProvider());
  assert.deepEqual((await library.saves()).map((s) => [s.campaignId, s.turn]), [["hollow-lantern", 7]]);
  const { session } = await library.get("hollow-lantern");
  assert.ok(await session.resume());
  assert.equal(session.status.turn, 7);
});

test("the menu offers saved games first, then a new game of each campaign, warning which would replace a save", async () => {
  const campaigns = await listCampaigns(DEFAULT_CONTENT_DIR);
  const now = new Date("2026-11-03T12:00:00Z");
  const items = menuItems(campaigns, [{ campaignId: "hollow-lantern", characterName: "Wren", turn: 14, updatedAt: "2026-11-03T09:30:00Z" }], now);
  assert.deepEqual(
    items.map((i) => [i.section, i.label, i.choice.kind]),
    [
      ["Continue", "The Hollow Lantern", "continue"],
      ["New game", "The Hollow Lantern", "new"],
      ["New game", "Those Dark Places", "new"],
      ["", "Quit", "quit"],
    ],
  );
  assert.equal(items[0].detail, "Wren, turn 14, 2 hours ago");
  assert.match(items[1].detail!, /replaces your saved game/);
  assert.doesNotMatch(items[2].detail!, /replaces/);
  assert.match(items[2].detail!, /Deep Bore 4 broke into something/);
});
