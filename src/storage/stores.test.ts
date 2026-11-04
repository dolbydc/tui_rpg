import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DEFAULT_CAMPAIGN_DIR } from "../config.js";
import type { NpcMemory, TurnRecord } from "../domain/types.js";
import { WorldEngine } from "../world/engine.js";
import { loadWorld } from "../world/loader.js";
import { newMemory } from "../world/memory.js";
import { InMemoryStore } from "./memory.js";
import { SqliteStore } from "./sqlite.js";
import type { CampaignStore } from "./store.js";

const world = new WorldEngine(await loadWorld(DEFAULT_CAMPAIGN_DIR));
const record = (turn: number, input: string): TurnRecord => ({ turn, input, events: [], output: [] });
const memory = (text: string): NpcMemory => newMemory(world.npc("old-pell"), { turn: 1, kind: "witnessed", about: "player", text });

for (const [name, open] of [
  ["sqlite", () => new SqliteStore(":memory:")],
  ["memory", () => new InMemoryStore()],
] as [string, () => CampaignStore][]) {
  test(`${name}: saves state, history and memories together, and loads them in order`, async () => {
    const store = open();
    const state = world.newGame("c");
    assert.equal(await store.load("c"), undefined);
    await store.commitTurn(state, record(1, ""), [memory("first")]);
    for (let i = 1; i <= 12; i++) await store.commitTurn({ ...state, turn: i }, record(i, `go ${i}`), [memory(`m${i}`)]);

    const saved = (await store.load("c"))!;
    assert.equal(saved.state.turn, 12);
    assert.deepEqual(saved.recent.map((r) => r.input), ["go 3", "go 4", "go 5", "go 6", "go 7", "go 8", "go 9", "go 10", "go 11", "go 12"]);
    assert.deepEqual(saved.memories.map((m) => m.text).slice(0, 3), ["first", "m1", "m2"]);
    assert.equal(saved.memories.length, 13);

    await store.reset("c");
    assert.equal(await store.load("c"), undefined);
    await store.close();
  });

  test(`${name}: lists saved games, newest first, and moves one to a new id with its history`, async () => {
    const store = open();
    await store.commitTurn({ ...world.newGame("old"), turn: 4 }, record(4, "look"), [memory("seen")]);
    await new Promise((r) => setTimeout(r, 5));
    await store.commitTurn(world.newGame("other"), record(1, ""));
    assert.deepEqual(
      (await store.saves()).map((s) => [s.campaignId, s.characterName, s.turn]),
      [["other", "Wren", 1], ["old", "Wren", 4]],
    );

    await store.rename("old", "new");
    assert.equal(await store.load("old"), undefined);
    const moved = (await store.load("new"))!;
    assert.equal(moved.state.campaignId, "new");
    assert.deepEqual(moved.recent.map((r) => r.input), ["look"]);
    assert.deepEqual(moved.memories.map((m) => m.text), ["seen"]);
    // Never over another save.
    await store.rename("new", "other");
    assert.ok(await store.load("new"));
    assert.equal((await store.load("other"))!.state.turn, 1);
    await store.close();
  });
}

test("sqlite: a campaign survives closing and reopening the file; reset removes its history too", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "rpg-")), "nested", "game.db");
  const first = new SqliteStore(file);
  await first.commitTurn(world.newGame("c"), record(1, "hello"), [memory("seen")]);
  await first.close();

  const second = new SqliteStore(file);
  const saved = (await second.load("c"))!;
  assert.equal(saved.recent[0].input, "hello");
  assert.equal(saved.memories[0].text, "seen");
  await second.reset("c");
  const left = second.db.prepare("select (select count(*) from turns) t, (select count(*) from npc_memories) m").get();
  assert.deepEqual(left, { t: 0, m: 0 });
  await second.close();
});

test("sqlite: a failed save leaves nothing half-written", async () => {
  const store = new SqliteStore(":memory:");
  const state = world.newGame("c");
  const m = memory("once");
  await store.commitTurn(state, record(1, "a"), [m]);
  // The same memory id again breaks the unique constraint, mid-transaction.
  await assert.rejects(store.commitTurn({ ...state, turn: 2 }, record(2, "b"), [m]));
  const saved = (await store.load("c"))!;
  assert.equal(saved.state.turn, 1);
  assert.deepEqual(saved.recent.map((r) => r.input), ["a"]);
});
