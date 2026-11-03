import assert from "node:assert/strict";
import { test } from "node:test";
import { layoutMap, mapLabel } from "./map.js";

test("places locations along compass exits, and other exits in the first free neighbouring cell", () => {
  const layout = layoutMap(
    [
      { id: "square", exits: { inn: "inn", east: "edge", shop: "shop" } },
      { id: "inn", exits: { out: "square" } },
      { id: "edge", exits: { west: "square", east: "deep" } },
      { id: "deep", exits: { west: "edge" } },
      { id: "shop", exits: { out: "square" } },
    ],
    "square",
  );
  assert.deepEqual(Object.fromEntries(layout), {
    square: { x: 0, y: 0, z: 0 },
    inn: { x: 0, y: -1, z: 0 }, // north is free
    edge: { x: 1, y: 0, z: 0 },
    deep: { x: 2, y: 0, z: 0 },
    shop: { x: 0, y: 1, z: 0 }, // north and east are taken
  });
});

test("keeps fixed positions, and never puts two places in one cell", () => {
  const layout = layoutMap(
    [
      { id: "a", exits: { east: "b", north: "c" } },
      { id: "b", exits: {}, map: { x: 1, y: 0, z: 0 } },
      { id: "c", exits: {} , map: { x: 5, y: 5, z: 0 } },
      { id: "d", exits: { west: "a" } },
    ],
    "a",
  );
  assert.deepEqual(layout.get("c"), { x: 5, y: 5, z: 0 });
  // d isn't reached from the start; it still gets a cell of its own.
  const cells = [...layout.values()].map(({ x, y }) => `${x},${y}`);
  assert.equal(new Set(cells).size, cells.length);

  assert.throws(
    () => layoutMap([{ id: "a", exits: {}, map: { x: 0, y: 0, z: 0 } }, { id: "b", exits: {}, map: { x: 0, y: 0, z: 0 } }], "a"),
    /both at map/,
  );
});

test("up and down lead to the level above or below, directly over or under", () => {
  const layout = layoutMap(
    [
      { id: "inn", exits: { down: "cellar", up: "attic", out: "square" } },
      { id: "cellar", exits: { up: "inn", east: "tunnel" } },
      { id: "tunnel", exits: { west: "cellar" } },
      { id: "attic", exits: { down: "inn" } },
      { id: "square", exits: { inn: "inn" } },
    ],
    "inn",
  );
  assert.deepEqual(Object.fromEntries(layout), {
    inn: { x: 0, y: 0, z: 0 },
    cellar: { x: 0, y: 0, z: -1 },
    tunnel: { x: 1, y: 0, z: -1 },
    attic: { x: 0, y: 0, z: 1 },
    square: { x: 0, y: -1, z: 0 },
  });
});

test("map labels fit in a cell", () => {
  assert.equal(mapLabel("Brackenford Square"), "Square");
  assert.equal(mapLabel("The Hollow Lantern"), "Lantern");
  assert.equal(mapLabel("Thornwood Depths 1"), "Depths 1");
  assert.equal(mapLabel("Edge of the Thornwood"), "Edge of…");
});
