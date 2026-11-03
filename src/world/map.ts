import type { GridPosition } from "../domain/types.js";

/** Longest map label; longer names are shortened (see mapLabel). */
export const MAP_LABEL = 8;

const COMPASS: Record<string, GridPosition> = {
  north: { x: 0, y: -1, z: 0 },
  south: { x: 0, y: 1, z: 0 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  northeast: { x: 1, y: -1, z: 0 },
  northwest: { x: -1, y: -1, z: 0 },
  southeast: { x: 1, y: 1, z: 0 },
  southwest: { x: -1, y: 1, z: 0 },
  n: { x: 0, y: -1, z: 0 },
  s: { x: 0, y: 1, z: 0 },
  e: { x: 1, y: 0, z: 0 },
  w: { x: -1, y: 0, z: 0 },
  ne: { x: 1, y: -1, z: 0 },
  nw: { x: -1, y: -1, z: 0 },
  se: { x: 1, y: 1, z: 0 },
  sw: { x: -1, y: 1, z: 0 },
};

/** Exits that change level: the destination is directly above or below. */
const VERTICAL: Record<string, GridPosition> = {
  up: { x: 0, y: 0, z: 1 },
  upstairs: { x: 0, y: 0, z: 1 },
  down: { x: 0, y: 0, z: -1 },
  downstairs: { x: 0, y: 0, z: -1 },
};

/** Where other exits ("inn", "out") are tried, in order, on the same level: the first free neighbour wins. */
const NEIGHBOURS = [COMPASS.north, COMPASS.east, COMPASS.south, COMPASS.west];

interface Placeable {
  id: string;
  exits: Record<string, string>;
  /** Fixed position from the location's frontmatter. */
  map?: GridPosition;
}

/**
 * Lays the locations out on a grid, starting from `start` at (0, 0) on level 0. Fixed positions are kept;
 * the rest are placed by walking the exits: a compass exit ("east") puts its destination one step that
 * way, "up" or "down" directly above or below (a level up or down), any other exit ("inn") in the first
 * free neighbouring cell on the same level. Two places never share a cell.
 */
export function layoutMap(locations: Placeable[], start: string): Map<string, GridPosition> {
  const positions = new Map<string, GridPosition>();
  const taken = new Map<string, string>();
  const place = (id: string, at: GridPosition) => {
    positions.set(id, at);
    taken.set(key(at), id);
  };

  for (const location of locations) {
    if (!location.map) continue;
    const other = taken.get(key(location.map));
    if (other) throw new Error(`Locations ${other} and ${location.id} are both at map ${key(location.map)}`);
    place(location.id, location.map);
  }

  const byId = new Map(locations.map((l) => [l.id, l]));
  const explored = new Set<string>();
  // Breadth-first along the exits from `root`, placing each destination relative to where it's reached from.
  const explore = (root: string) => {
    if (!positions.has(root)) place(root, freeNear({ x: 0, y: 0, z: 0 }, taken));
    const queue = [root];
    for (const id of queue) {
      const from = byId.get(id);
      if (!from || explored.has(id)) continue;
      explored.add(id);
      const origin = positions.get(id)!;
      for (const [exit, to] of Object.entries(from.exits)) {
        if (!positions.has(to)) {
          const step = COMPASS[exit.toLowerCase()] ?? VERTICAL[exit.toLowerCase()];
          const wanted = step
            ? offset(origin, step)
            : NEIGHBOURS.map((n) => offset(origin, n)).find((p) => !taken.has(key(p)));
          place(to, freeNear(wanted ?? origin, taken));
        }
        queue.push(to);
      }
    }
  };
  explore(start);
  // Then anything the start's exits never reach.
  for (const location of locations) explore(location.id);
  return positions;
}

/** Whether two cells are side by side on the same level (not diagonal). */
export function isAdjacent(a: GridPosition, b: GridPosition): boolean {
  return a.z === b.z && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

/** A label that fits the map: the name without a leading "The", else its last words that fit, else cut short. */
export function mapLabel(name: string): string {
  const words = name.replace(/^the\s+/i, "").split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const tail = words.slice(i).join(" ");
    if (tail.length <= MAP_LABEL) return tail;
  }
  return `${words.join(" ").slice(0, MAP_LABEL - 1)}…`;
}

/** The nearest free cell to `at` on its level, searching outwards ring by ring. */
function freeNear(at: GridPosition, taken: Map<string, string>): GridPosition {
  for (let r = 0; ; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const p = offset(at, { x: dx, y: dy, z: 0 });
        if (!taken.has(key(p))) return p;
      }
    }
  }
}

function offset(a: GridPosition, b: GridPosition): GridPosition {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function key({ x, y, z }: GridPosition): string {
  return z ? `(${x}, ${y}) on level ${z}` : `(${x}, ${y})`;
}
