import type { TimeOfDay } from "../domain/types.js";

/** In-game seconds a turn takes: ten minutes, or six seconds in a conversation or a confrontation. */
export const TURN_SECONDS = 600;
export const QUICK_TURN_SECONDS = 6;
/** NPC routines move on a step every this many seconds, however long turns are. */
export const ROUTINE_STEP_SECONDS = TURN_SECONDS;
/** When the player wakes from sleep, in minutes after midnight. */
export const WAKE_AT = 7 * 60;

const DAY = 24 * 60;

/** Parts of the day, by the minute (from midnight) each begins. */
const PHASES: [start: number, phase: TimeOfDay["phase"]][] = [
  [0, "night"],
  [5 * 60, "dawn"],
  [7 * 60, "morning"],
  [12 * 60, "afternoon"],
  [17 * 60, "evening"],
  [20 * 60, "night"],
];

/** The time `elapsed` seconds into a campaign that starts on day 1 at `start` (minutes after midnight). */
export function timeAt(elapsed: number, start: number): TimeOfDay {
  const total = start + Math.floor(elapsed / 60);
  const minutes = total % DAY;
  const phase = PHASES.findLast(([from]) => minutes >= from)![1];
  return { day: Math.floor(total / DAY) + 1, minutes, phase };
}

/** Seconds from `elapsed` until the player wakes: the next WAKE_AT (the one after, if it's that minute now). */
export function secondsUntilWaking(elapsed: number, start: number): number {
  const now = start * 60 + elapsed;
  const wake = WAKE_AT * 60;
  const intoDay = now % (DAY * 60);
  return (wake - intoDay + DAY * 60) % (DAY * 60) || DAY * 60;
}

/** "07:20". */
export function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** "Day 2, morning (07:20)": for the narrator and NPCs. */
export function describeTime(time: TimeOfDay): string {
  return `day ${time.day}, ${time.phase} (${clock(time.minutes)})`;
}

/** "20:00" → 1200. */
export function parseClock(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}
