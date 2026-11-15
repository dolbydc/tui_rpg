import { pathToFileURL } from "node:url";
import type { Game, GameView } from "../engine/api.js";

/** What the window pictures beside the terminal: where the player is, and who's with them. */
export interface Art {
  place?: { name: string; url?: string };
  people: { label: string; appearance: string; url?: string }[];
}

export function artOf(view: GameView): Art {
  const player = view.player;
  if (!player) return { people: [] };
  const url = (file?: string) => (file ? { url: pathToFileURL(file).href } : {});
  return {
    place: { name: player.place.name, ...url(player.place.image) },
    people: player.people.map((p) => ({ label: p.label, appearance: p.appearance, ...url(p.image) })),
  };
}

/** `game`, telling `onView` the game as it stands after each campaign opened and each turn. */
export function watchViews(game: Game, onView: (view: GameView) => void): Game {
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
    close: () => game.close(),
  };
}
