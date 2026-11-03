import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CAMPAIGN_DIR } from "../config.js";
import type { Intent } from "../domain/types.js";
import { fixedDice as dice, outcomeOf, rollCheck, statBonus } from "./checks.js";
import { WorldEngine } from "./engine.js";
import { loadWorld } from "./loader.js";

test("stat bonuses: 1 → −1, 2 → 0, 3–4 → +1, 5–6 → +2, 7+ → +3", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 9].map(statBonus), [-1, 0, 1, 1, 2, 2, 3, 3]);
});

test("outcomes: 2 or less fails, 3–4 partly fails, 5–6 partly succeeds, 7+ succeeds", () => {
  assert.deepEqual([0, 2, 3, 4, 5, 6, 7, 9].map(outcomeOf), [
    "failure",
    "failure",
    "partial_failure",
    "partial_failure",
    "partial_success",
    "partial_success",
    "success",
    "success",
  ]);
});

test("a check keeps the best of 2d6, or of 3d6 when pushed", () => {
  assert.deepEqual(rollCheck(dice(2, 5), "might", 3, "lift the cart"), {
    stat: "might",
    why: "lift the cart",
    dice: [2, 5],
    die: 5,
    bonus: 1,
    total: 6,
    outcome: "partial_success",
  });
  const pushed = rollCheck(dice(2, 5, 6), "might", 3, "lift the cart", { pushed: true });
  assert.deepEqual([pushed.dice, pushed.total, pushed.outcome, pushed.pushed], [[2, 5, 6], 7, "success", true]);
});

test("the odds match the published tables", () => {
  // Every combination of faces, for each stat: [failure, partial failure, partial success, success] in %.
  const odds = (value: number, pushed = false) => {
    const counts = { failure: 0, partial_failure: 0, partial_success: 0, success: 0 };
    const n = pushed ? 3 : 2;
    for (let i = 0; i < 6 ** n; i++) {
      const faces = Array.from({ length: n }, (_, d) => (Math.floor(i / 6 ** d) % 6) + 1);
      counts[rollCheck(dice(...faces), "s", value, "x", { pushed }).outcome]++;
    }
    return Object.values(counts).map((c) => Math.round((c / 6 ** n) * 100));
  };
  assert.deepEqual(odds(1), [25, 44, 31, 0]);
  assert.deepEqual(odds(3), [3, 22, 44, 31]);
  assert.deepEqual(odds(5), [0, 11, 33, 56]);
  assert.deepEqual(odds(3, true), [0, 12, 45, 42]);
  assert.deepEqual(odds(7, true), [0, 0, 12, 88]);
});

test("a flagged attempt is rolled against the stat; a partial success sets up a hidden complication", async () => {
  const definition = await loadWorld(DEFAULT_CAMPAIGN_DIR);
  const lie: Intent = {
    kind: "talk",
    npc: "old man",
    message: "I'm the magistrate's nephew.",
    check: { stat: "Charisma", why: "pass themselves off as the magistrate's nephew" },
  };
  const roll = (faces: number[], intent: Intent = lie) => {
    const world = new WorldEngine(definition, dice(...faces));
    const state = world.newGame("t");
    const resolution = world.resolve(intent, state);
    assert.ok(resolution.ok);
    return world.check(intent, resolution, state, "I tell him I'm the magistrate's nephew");
  };

  // Wren's charisma is 3: +1. The best die is a 4, for 5: a partial success.
  const [checked, pending] = roll([4, 1]);
  assert.deepEqual(checked, {
    type: "checked",
    check: {
      stat: "charisma",
      why: lie.check!.why,
      dice: [4, 1],
      die: 4,
      bonus: 1,
      total: 5,
      outcome: "partial_success",
      npcId: "old-pell",
    },
  });
  assert.equal(pending.type, "complication_pending");
  assert.ok(pending.type === "complication_pending");
  assert.deepEqual(
    { ...pending.complication, id: "" },
    { id: "", turn: 1, due: 1200, input: "I tell him I'm the magistrate's nephew", why: lie.check!.why, locationId: "village-square", npcId: "old-pell" },
  );

  assert.equal(roll([1, 1]).length, 1, "a failure leaves no complication");
  assert.deepEqual(roll([], { kind: "look" }), [], "nothing to roll for");
  assert.deepEqual(roll([6], { kind: "act", action: "sing", check: { stat: "luck", why: "sing" } }), [], "no such stat");
});
