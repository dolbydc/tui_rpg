import type { GridPosition, MapCell, MapView } from "../domain/types.js";

/** How a map character is drawn; see MAP_STYLES in panels.tsx. */
export type GlyphStyle = "border" | "here" | "link" | "label" | "hereLabel" | "player" | "person" | "item" | "stairs";

export interface Glyph {
  ch: string;
  style?: GlyphStyle;
}

// Each place is a box with three lines inside: its label, who's there, and items lying about.
// The inside is as wide as the longest map label (MAP_LABEL in world/map.ts).
const INNER_W = 8;
const INNER_H = 3;
const BOX_W = INNER_W + 2;
const BOX_H = INNER_H + 2;
// Boxes sit one character apart, with a one-character margin round the map for exits off its edge.
const PITCH_X = BOX_W + 1;
const PITCH_Y = BOX_H + 1;
/** Items shown as one dot each, up to this many; more are shown as a count. */
const ITEM_DOTS = 4;

/** How many places fit across a map `width` characters wide. */
export function cellsAcross(width: number): number {
  return Math.max(1, Math.floor((width - 1) / PITCH_X));
}

/**
 * Draws the visited places as a character grid, up to `cols` × `rows` places around the player. Exits
 * join neighbouring boxes; an exit to somewhere not yet visited is drawn as a stub leading off the box.
 */
export function renderMap(view: MapView, cols: number, rows: number): Glyph[][] {
  const here = view.cells.find((c) => c.here) ?? view.cells[0];
  if (!here) return [];
  const across = span(view.cells.map((c) => c.position.x), cols, here.position.x);
  const down = span(view.cells.map((c) => c.position.y), rows, here.position.y);
  const width = across.size * PITCH_X + 1;
  const height = down.size * PITCH_Y + 1;
  const grid: Glyph[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: " " })));

  const set = (x: number, y: number, ch: string, style: GlyphStyle) => {
    if (y >= 0 && y < height && x >= 0 && x < width) grid[y][x] = { ch, style };
  };
  const write = (x: number, y: number, text: string, style: GlyphStyle) => [...text].forEach((ch, i) => set(x + i, y, ch, style));
  const inView = ({ x, y }: GridPosition) =>
    x >= across.start && x < across.start + across.size && y >= down.start && y < down.start + down.size;
  const corner = ({ x, y }: GridPosition) => ({ x: 1 + (x - across.start) * PITCH_X, y: 1 + (y - down.start) * PITCH_Y });

  const cells = new Map(view.cells.map((c) => [key(c.position), c]));
  for (const cell of view.cells) {
    if (!inView(cell.position)) continue;
    const { x, y } = corner(cell.position);
    const border: GlyphStyle = cell.here ? "here" : "border";
    write(x, y, `╭${"─".repeat(INNER_W)}╮`, border);
    for (let row = 1; row <= INNER_H; row++) {
      set(x, y + row, "│", border);
      set(x + BOX_W - 1, y + row, "│", border);
    }
    write(x, y + BOX_H - 1, `╰${"─".repeat(INNER_W)}╯`, border);
    // Stairs sit on the border, off-centre so they don't collide with an exit north or south.
    if (cell.stairs.up) set(x + 2, y, "▲", "stairs");
    if (cell.stairs.down) set(x + 2, y + BOX_H - 1, "▼", "stairs");
    contents(cell).forEach((line, row) => {
      let column = x + 1 + Math.floor((INNER_W - line.length) / 2);
      for (const glyph of line) set(column++, y + 1 + row, glyph.ch, glyph.style ?? "label");
    });
  }

  for (const { from, to } of view.links) {
    for (const [end, other] of [
      [from, to],
      [to, from],
    ]) {
      const cell = cells.get(key(end));
      if (!cell || !inView(end)) continue;
      const border: GlyphStyle = cell.here ? "here" : "border";
      const { x, y } = corner(end);
      const midX = x + Math.floor(BOX_W / 2);
      const midY = y + Math.floor(BOX_H / 2);
      if (other.x > end.x) {
        set(x + BOX_W - 1, midY, "├", border);
        set(x + BOX_W, midY, "─", "link");
      } else if (other.x < end.x) {
        set(x, midY, "┤", border);
        set(x - 1, midY, "─", "link");
      } else if (other.y > end.y) {
        set(midX, y + BOX_H - 1, "┬", border);
        set(midX, y + BOX_H, "│", "link");
      } else {
        set(midX, y, "┴", border);
        set(midX, y - 1, "│", "link");
      }
    }
  }
  return grid;
}

/** The three lines inside a place's box. */
function contents(cell: MapCell): Glyph[][] {
  const label = [...cell.label].map((ch): Glyph => ({ ch, style: cell.here ? "hereLabel" : "label" }));
  const marks: Glyph[] = cell.here ? [{ ch: "@", style: "player" }] : [];
  for (const person of cell.people) marks.push({ ch: person ?? "?", style: "person" });
  const people = marks.flatMap((mark, i) => (i ? [{ ch: " " }, mark] : [mark])).slice(0, INNER_W);
  const dots = cell.items <= ITEM_DOTS ? "•".repeat(cell.items) : `•×${cell.items}`;
  const items = [...dots].map((ch): Glyph => ({ ch, style: "item" }));
  return [label, people, items];
}

/** Which `size` consecutive values (at most) to show, centred on `centre` but kept within the occupied range. */
function span(values: number[], size: number, centre: number): { start: number; size: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const shown = Math.max(1, Math.min(size, max - min + 1));
  const start = Math.min(Math.max(centre - Math.floor((shown - 1) / 2), min), max - shown + 1);
  return { start, size: shown };
}

function key({ x, y }: GridPosition): string {
  return `${x},${y}`;
}
