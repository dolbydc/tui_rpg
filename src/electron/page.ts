// What the window's page draws around the terminal: the picture of the place, and the panels beside it
// (map, character, inventory, quests, who's here). Everything is worked out here, in the main process, so the
// page only puts it on screen: files become URLs, stats get their bonuses, the map becomes shapes.
import { pathToFileURL } from "node:url";
import { clock, formatBonus, statBonus, type Game, type GameView, type MapView } from "../engine/api.js";

export interface PageView {
  title: string;
  /** Undefined until there's a game (at the menu, or while a character is made): the page shows just the terminal. */
  player?: {
    /** `drawing`: its picture is on its way. */
    place: { name: string; url?: string; drawing?: boolean };
    /** Who's here, with their portrait, or `drawing` while it's on its way. */
    people: { label: string; appearance: string; url?: string; drawing?: boolean }[];
    character: {
      name: string;
      pronouns: string;
      hp: number;
      maxHp: number;
      level: number;
      xp: number;
      nextLevelXp: number;
      /** Enough experience for /levelup. */
      canLevelUp: boolean;
      stats: { name: string; value: number; bonus: string }[];
    };
    turn: { number: number; actionsLeft: number; actionsPerTurn: number; drive: number; drivePerQuest: number };
    /** "Day 1 · night", "20:00". */
    time: { day: string; clock: string };
    inventory: string[];
    quests: { title: string; done: boolean }[];
    /** The map round the player, for the panel. */
    map: MapShapes;
    /** All of this level, for the map opened full-size. */
    fullMap: MapShapes;
  };
}

/** The map as boxes and lines in SVG user units; the page scales the whole thing to fit. */
export interface MapShapes {
  /** "minX minY width height", for the SVG's viewBox: the whole map, or as much of it round the player as fits. */
  viewBox: string;
  /** Each place's box. */
  box: { w: number; h: number };
  /** "1 below ground", "2 up"; undefined on the ground. */
  level?: string;
  links: { x1: number; y1: number; x2: number; y2: number; stub: boolean }[];
  places: {
    x: number;
    y: number;
    label: string;
    here: boolean;
    /** Who's there, where the player is: "@" for the player, an initial or "?" for each other person. */
    people: string[];
    items: number;
    stairs: { up: boolean; down: boolean };
    /** Its picture, shown in its box. */
    url?: string;
  }[];
}

/** A place's box: its picture across the top, its name in a strip along the bottom. */
const BOX = { w: 150, h: 112 };
const PITCH = { x: 210, y: 160 };
/** Room round the edge for exits off it. */
const MARGIN = 28;
/** The most places shown across and down; a bigger map is shown round the player, as the terminal's is. */
const SHOWN = { across: 3, down: 3 };

/** The map as shapes: round the player, as much as SHOWN allows (`crop`), or all of the level. */
export function mapShapes(map: MapView, crop = true): MapShapes {
  const at = (p: { x: number; y: number }) => ({ x: p.x * PITCH.x, y: p.y * PITCH.y });
  const centre = (p: { x: number; y: number }) => ({ x: p.x * PITCH.x + BOX.w / 2, y: p.y * PITCH.y + BOX.h / 2 });
  const visited = new Set(map.cells.map((c) => `${c.position.x},${c.position.y}`));
  const places = map.cells.map((cell) => ({
    ...at(cell.position),
    label: cell.label,
    here: cell.here,
    people: cell.here ? ["@", ...cell.people.map((p) => p ?? "?")] : [],
    items: cell.items,
    stairs: cell.stairs,
    ...(cell.image && { url: pathToFileURL(cell.image).href }),
  }));
  const links = map.links.map(({ from, to }) => {
    const a = centre(from);
    const b = centre(to);
    // An exit to somewhere not yet visited leads off its box, halfway to where the next place would be.
    const stub = !visited.has(`${to.x},${to.y}`);
    return stub ? { x1: a.x, y1: a.y, x2: (a.x + b.x) / 2, y2: (a.y + b.y) / 2, stub } : { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stub };
  });
  const xs = [...places.flatMap((p) => [p.x, p.x + BOX.w]), ...links.flatMap((l) => [l.x1, l.x2])];
  const ys = [...places.flatMap((p) => [p.y, p.y + BOX.h]), ...links.flatMap((l) => [l.y1, l.y2])];
  const [minX, maxX, minY, maxY] = xs.length ? [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)] : [0, BOX.w, 0, BOX.h];
  const here = places.find((p) => p.here) ?? { x: minX, y: minY };
  const across = crop ? SHOWN.across * PITCH.x - (PITCH.x - BOX.w) : Infinity;
  const down = crop ? SHOWN.down * PITCH.y - (PITCH.y - BOX.h) : Infinity;
  const x = window1d(minX, maxX, here.x + BOX.w / 2, across);
  const y = window1d(minY, maxY, here.y + BOX.h / 2, down);
  return {
    viewBox: [x.from - MARGIN, y.from - MARGIN, x.size + 2 * MARGIN, y.size + 2 * MARGIN].join(" "),
    box: BOX,
    ...(map.level !== 0 && { level: map.level < 0 ? `${-map.level} below ground` : `${map.level} up` }),
    links,
    places,
  };
}

/** All of [min, max] if it's no wider than `size`; otherwise `size` of it, centred on `centre` but kept inside. */
function window1d(min: number, max: number, centre: number, size: number): { from: number; size: number } {
  if (max - min <= size) return { from: min, size: max - min };
  return { from: Math.min(Math.max(centre - size / 2, min), max - size), size };
}

export function pageOf(view: GameView): PageView {
  const player = view.player;
  if (!player) return { title: view.title };
  const url = (file?: string) => (file ? { url: pathToFileURL(file).href } : {});
  const { character, status } = player;
  return {
    title: view.title,
    player: {
      place: { name: player.place.name, ...url(player.place.image), ...(player.place.drawing && { drawing: true }) },
      people: player.people.map((p) => ({
        label: capitalize(p.label),
        appearance: p.appearance,
        ...url(p.image),
        ...(p.drawing && !p.image && { drawing: true }),
      })),
      character: {
        name: character.name,
        pronouns: character.pronouns,
        hp: character.hp,
        maxHp: character.maxHp,
        level: character.level,
        xp: character.xp,
        nextLevelXp: status.nextLevelXp,
        canLevelUp: character.xp >= status.nextLevelXp,
        stats: Object.entries(character.stats)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, value]) => ({ name, value, bonus: formatBonus(statBonus(value)) })),
      },
      turn: {
        number: status.turn,
        actionsLeft: status.actionsLeft,
        actionsPerTurn: status.actionsPerTurn,
        drive: status.drive,
        drivePerQuest: status.drivePerQuest,
      },
      time: { day: `Day ${status.time.day} · ${status.time.phase}`, clock: clock(status.time.minutes) },
      inventory: character.inventory,
      quests: player.quests.map((q) => ({ title: q.title, done: q.status === "completed" })),
      map: mapShapes(player.map),
      fullMap: mapShapes(player.map, false),
    },
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `game`, telling `onView` the game as it stands after each campaign opened, each turn, and each change between. */
export function watchViews(game: Game, onView: (view: GameView) => void): Game {
  game.subscribe((event) => {
    if (event.kind === "view") onView(event.view);
  });
  return {
    library: () => game.library(),
    async open(campaignId, mode) {
      const opened = await game.open(campaignId, mode);
      onView(opened.view);
      return opened;
    },
    async submit(text) {
      const outcome = await game.submit(text);
      onView(outcome.menu || outcome.quit ? { title: outcome.view.title } : outcome.view);
      return outcome;
    },
    subscribe: (listener) => game.subscribe(listener),
    close: () => game.close(),
  };
}
