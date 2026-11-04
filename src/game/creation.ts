import type { Character, LogLine } from "../domain/types.js";
import { formatBonus, statBonus } from "../world/checks.js";

/** Points a new character shares out among their stats, and the range each stat must fall in. */
export const STAT_POINTS = 10;
export const STAT_MIN = 1;
export const STAT_MAX = 6;

/** Where the player is in making a new character; each answer moves it on a step. */
export type Creation =
  | { step: "name" }
  | { step: "pronouns"; name: string }
  | { step: "stats"; name: string; pronouns: string }
  | { step: "confirm"; character: Character };

export interface CreationStep {
  /** The next step, or undefined once the character is made. */
  creation?: Creation;
  /** The finished character. */
  done?: Character;
  lines: LogLine[];
}

const PRONOUN_SHORTHAND: Record<string, string> = { she: "she/her", he: "he/him", they: "they/them" };

const ask = (text: string): LogLine => ({ kind: "system", text });

/** The first prompt. */
export function startCreation(): CreationStep {
  return {
    creation: { step: "name" },
    lines: [ask("A new character. (Type /cancel to go back.)"), ask("What is your character's name?")],
  };
}

/**
 * Takes the player's answer to the current prompt. `template` is the campaign's own character: the new
 * one has its stat names, health and starting kit.
 */
export function advanceCreation(creation: Creation, input: string, template: Character): CreationStep {
  const answer = input.trim();
  switch (creation.step) {
    case "name":
      if (answer.length > 30) return { creation, lines: [ask("Keep it under 30 characters. What is their name?")] };
      return {
        creation: { step: "pronouns", name: answer },
        lines: [ask(`${answer}'s pronouns? (e.g. she/her, he/him, they/them)`)],
      };
    case "pronouns": {
      const pronouns = PRONOUN_SHORTHAND[answer.toLowerCase()] ?? answer.toLowerCase();
      if (pronouns.length > 20) return { creation, lines: [ask("Keep it short, like she/her. Their pronouns?")] };
      return { creation: { step: "stats", name: creation.name, pronouns }, lines: [statsPrompt(template)] };
    }
    case "stats": {
      const parsed = parseStats(answer, Object.keys(template.stats));
      if (typeof parsed === "string") return { creation, lines: [ask(parsed), statsPrompt(template)] };
      const character: Character = {
        ...structuredClone(template),
        name: creation.name,
        pronouns: creation.pronouns,
        stats: parsed,
        level: 1,
        xp: 0,
      };
      return {
        creation: { step: "confirm", character },
        lines: [ask(summary(character)), ask("Begin with this character? (yes / no to start over)")],
      };
    }
    case "confirm":
      if (/^y(es)?$/i.test(answer)) return { done: creation.character, lines: [] };
      if (/^no?$/i.test(answer)) return startCreation();
      return { creation, lines: [ask("yes to begin, no to start over.")] };
  }
}

function statsPrompt(template: Character): LogLine {
  const names = Object.keys(template.stats);
  // An even split, as the example: 10 among four stats is 3 3 2 2.
  const even = names.map((n, i) => `${n} ${Math.floor(STAT_POINTS / names.length) + (i < STAT_POINTS % names.length ? 1 : 0)}`);
  return ask(
    `Share ${STAT_POINTS} points among ${names.join(", ")}; each must be ${STAT_MIN}–${STAT_MAX}. ` +
      `Rolls get −1 for 1, nothing for 2, +1 for 3–4, +2 for 5–6. ` +
      `E.g. "${even.join(" ")}", or just the numbers in that order.`,
  );
}

/** "might 3 wits 3 grace 2 charisma 2", "3 3 2 2" or any prefix of the names ("cha 2"). Returns an error message if it doesn't add up. */
export function parseStats(input: string, names: string[]): Record<string, number> | string {
  const tokens = input.toLowerCase().split(/[\s,:=]+/).filter(Boolean);
  const stats: Record<string, number> = {};
  if (tokens.every((t) => /^\d+$/.test(t))) {
    if (tokens.length !== names.length) return `Give ${names.length} numbers, one each for ${names.join(", ")}.`;
    names.forEach((name, i) => (stats[name] = Number(tokens[i])));
  } else {
    for (let i = 0; i < tokens.length; i += 2) {
      const name = names.find((n) => n.startsWith(tokens[i]));
      const value = tokens[i + 1];
      if (!name || !value || !/^\d+$/.test(value)) return `I couldn't read "${input}".`;
      stats[name] = Number(value);
    }
    const missing = names.filter((n) => stats[n] === undefined);
    if (missing.length) return `Give a value for ${missing.join(", ")} too.`;
  }
  const outOfRange = names.filter((n) => stats[n] < STAT_MIN || stats[n] > STAT_MAX);
  if (outOfRange.length) return `Each stat must be ${STAT_MIN}–${STAT_MAX} (${outOfRange.join(", ")} isn't).`;
  const total = names.reduce((sum, n) => sum + stats[n], 0);
  if (total !== STAT_POINTS) return `That's ${total} points; use exactly ${STAT_POINTS}.`;
  return Object.fromEntries(names.map((n) => [n, stats[n]]));
}

function summary(character: Character): string {
  const stats = Object.entries(character.stats)
    .map(([stat, value]) => `${stat} ${value} (${formatBonus(statBonus(value))})`)
    .join(", ");
  return `${character.name} (${character.pronouns}): ${stats}. HP ${character.maxHp}.`;
}
