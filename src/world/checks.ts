import { randomUUID } from "node:crypto";
import type { CheckOutcome, CheckResult, Complication, GameState } from "../domain/types.js";

/** A random number in [0, 1); injectable so tests can fix the dice. */
export type Rng = () => number;

/** Dice that come up with the given faces in turn, then as low as they can: for tests and replays. */
export function fixedDice(...faces: number[]): Rng {
  let i = 0;
  return () => (i < faces.length ? (faces[i++] - 1) / SIDES : 0);
}

/** A check rolls DICE dice and keeps the highest; spending drive rolls PUSHED_DICE instead. */
export const DICE = 2;
export const PUSHED_DICE = 3;
export const SIDES = 6;

/** Drive the player has to push rolls with, restored whenever a new quest starts. */
export const DRIVE_PER_QUEST = 2;

/** Stat value → bonus to the roll: 1 → −1, 2 → 0, 3–4 → +1, 5–6 → +2, 7 and up → +3. */
export function statBonus(value: number): number {
  if (value <= 1) return -1;
  if (value <= 2) return 0;
  if (value <= 4) return 1;
  if (value <= 6) return 2;
  return 3;
}

/** A bonus as shown to the player: "+1", "−1" or "±0". */
export function formatBonus(bonus: number): string {
  return bonus > 0 ? `+${bonus}` : bonus < 0 ? `−${-bonus}` : "±0";
}

/** Best die + bonus → outcome: 2 or less fails outright, 3–4 partly fails, 5–6 partly succeeds, 7+ succeeds. */
export function outcomeOf(total: number): CheckOutcome {
  if (total <= 2) return "failure";
  if (total <= 4) return "partial_failure";
  if (total <= 6) return "partial_success";
  return "success";
}

/** Rolls the dice (more of them if `pushed`), keeps the best and adds the stat's bonus. */
export function rollCheck(
  rng: Rng,
  stat: string,
  value: number,
  why: string,
  { npcId, pushed = false }: { npcId?: string; pushed?: boolean } = {},
): CheckResult {
  const dice = Array.from({ length: pushed ? PUSHED_DICE : DICE }, () => 1 + Math.floor(rng() * SIDES));
  const die = Math.max(...dice);
  const bonus = statBonus(value);
  const total = die + bonus;
  return {
    stat,
    why,
    dice,
    die,
    bonus,
    total,
    outcome: outcomeOf(total),
    ...(pushed ? { pushed } : {}),
    ...(npcId ? { npcId } : {}),
  };
}

/** In-game time after a partial success before its complication can surface: 20 to 50 minutes. */
const COMPLICATION_DELAY = { min: 2, max: 5, unit: 600 };

/** The hidden cost of a partial success at `locationId`, due a few turns from now. */
export function complicationFor(
  rng: Rng,
  check: CheckResult,
  state: GameState,
  input: string,
  locationId: string,
): Complication {
  const delay = COMPLICATION_DELAY.min + Math.floor(rng() * (COMPLICATION_DELAY.max - COMPLICATION_DELAY.min + 1));
  return {
    id: randomUUID(),
    turn: state.turn,
    due: state.elapsed + delay * COMPLICATION_DELAY.unit,
    input,
    why: check.why,
    locationId,
    ...(check.npcId ? { npcId: check.npcId } : {}),
  };
}

/** Complications aimed at NPCs that are due: the NPC works out what really happened, wherever they are. */
export function dueRealisations(state: GameState): Complication[] {
  return state.complications.filter((c) => c.npcId && c.due <= state.elapsed);
}

/** A complication due at the place the player is now: it surfaces in front of them. */
export function dueHere(state: GameState): Complication | undefined {
  return state.complications.find((c) => !c.npcId && c.due <= state.elapsed && c.locationId === state.locationId);
}
