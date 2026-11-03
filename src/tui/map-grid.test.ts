import assert from "node:assert/strict";
import { test } from "node:test";
import type { MapView } from "../domain/types.js";
import { cellsAcross, renderMap } from "./map-grid.js";

const text = (view: Omit<MapView, "level">, cols = 3, rows = 2) => renderMap({ level: 0, ...view }, cols, rows).map((row) => row.map((g) => g.ch).join(""));

const square = { id: "square", label: "Square", position: { x: 0, y: 0, z: 0 }, here: true, people: ["P", undefined], items: 1, stairs: { up: false, down: false } };
const inn = { id: "inn", label: "Inn", position: { x: 0, y: -1, z: 0 }, here: false, people: [], items: 0, stairs: { up: false, down: true } };

test("draws each visited place as a box with its label, who's there and what's lying about", () => {
  const rows = text({ cells: [square], links: [] });
  assert.deepEqual(rows, [
    "            ",
    " ╭────────╮ ",
    " │ Square │ ",
    " │ @ P ?  │ ",
    " │   •    │ ",
    " ╰────────╯ ",
    "            ",
  ]);
});

test("joins neighbouring places, and shows exits into places not yet visited as stubs", () => {
  const rows = text({
    cells: [inn, square],
    links: [
      { from: inn.position, to: square.position },
      { from: square.position, to: { x: 1, y: 0, z: 0 } },
    ],
  });
  assert.deepEqual(rows.slice(5, 9), [" ╰─▼──┬───╯ ", "      │     ", " ╭────┴───╮ ", " │ Square │ "]);
  assert.equal(rows[9], " │ @ P ?  ├─");
  assert.equal(rows[0].length, 12, "the unvisited place east isn't drawn");
});

test("a map bigger than the panel is cropped around the player", () => {
  const row = Array.from({ length: 6 }, (_, x) => ({ ...inn, id: `p${x}`, label: `P${x}`, position: { x, y: 0, z: 0 } }));
  row[4] = { ...row[4], here: true };
  const shown = text({ cells: row, links: [] }, 3, 1)[2];
  assert.match(shown, /P3.*P4.*P5/);
  assert.doesNotMatch(shown, /P2/);
  assert.equal(cellsAcross(34), 3);
});
