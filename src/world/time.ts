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

/** What the sky's doing in each part of the day: the bare word "evening" isn't always enough to stop a model guessing. */
const DAYLIGHT: Record<TimeOfDay["phase"], string> = {
  dawn: "the sun is coming up",
  morning: "the sun is up and the day is still young; it's hours until dark",
  afternoon: "it's broad daylight, with the evening still hours off",
  evening: "the sun is going down",
  night: "it's dark",
};

/** "day 2, morning (07:20): the sun is up and…": for the narrator and NPCs. */
export function describeTime(time: TimeOfDay): string {
  return `day ${time.day}, ${time.phase} (${clock(time.minutes)}): ${DAYLIGHT[time.phase]}`;
}

/** "a few minutes", "about 40 minutes", "about 3 hours", "2 days": how long ago, roughly. */
export function describeSpan(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 5) return "a few minutes";
  if (minutes < 60) return `about ${Math.round(minutes / 10) * 10 || 5} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "about an hour" : `about ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "a day" : `${days} days`;
}

/** "20:00" → 1200. */
export function parseClock(text: string): number | undefined {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const [hours, minutes] = [Number(match[1]), Number(match[2])];
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : undefined;
}
