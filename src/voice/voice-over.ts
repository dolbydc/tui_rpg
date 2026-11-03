import type { LogLine, NpcDef, WorldDefinition } from "../domain/types.js";
import type { Speaker, Utterance } from "./speaker.js";

/** Kokoro voices used when the campaign doesn't choose: the narrator, and NPCs by pronouns. */
export const DEFAULT_VOICES = {
  narrator: "bm_george",
  she: "bf_alice",
  he: "bm_daniel",
  they: "af_river",
};

type Voiced = Pick<WorldDefinition, "narratorVoice" | "npcs"> & Partial<Pick<WorldDefinition, "locations">>;

/**
 * Who says what in the log: narration in the narrator's voice; NPC speech in theirs, their *actions*
 * narrated. A line that's only a place's name (the heading over a scene) is shown but not read out.
 */
export function voiceScript(lines: LogLine[], world: Voiced): Utterance[] {
  const narrator = world.narratorVoice ?? DEFAULT_VOICES.narrator;
  const places = new Set([...(world.locations?.values() ?? [])].map((l) => bare(l.name)));
  return lines.flatMap((line): Utterance[] => {
    if (line.kind === "narration") {
      const text = line.text
        .split("\n")
        .filter((l) => !places.has(bare(l)))
        .join("\n");
      return /\w/.test(text) ? [{ text, voice: narrator }] : [];
    }
    if (line.kind !== "npc") return []; // the player's own input, system notes and errors stay silent
    const npc = line.npcId ? world.npcs.get(line.npcId) : undefined;
    const voice = npc ? npcVoice(npc) : narrator;
    // "Speech." *She leans in.* "More speech." → alternate voices, in order.
    return line.text
      .split(/(\*[^*]*\*)/)
      .map((part): Utterance => (part.startsWith("*") ? { text: part.slice(1, -1), voice: narrator } : { text: part, voice }))
      .map((u) => ({ ...u, text: u.text.replace(/[“”"]/g, "").trim() }))
      .filter((u) => /\w/.test(u.text));
  });
}

/** A line as a heading, without formatting or closing punctuation, to compare with place names. */
function bare(line: string): string {
  return line.replace(/[*#_]/g, "").replace(/[.:!]+$/, "").trim().toLowerCase();
}

function npcVoice(npc: NpcDef): string {
  if (npc.voice) return npc.voice;
  const subject = npc.pronouns.split("/")[0].trim().toLowerCase();
  return subject === "she" ? DEFAULT_VOICES.she : subject === "he" ? DEFAULT_VOICES.he : DEFAULT_VOICES.they;
}

/** Reads the game's output aloud, unless switched off. */
export class VoiceOver {
  private readonly speaker: Speaker;
  private readonly world: Voiced;
  enabled: boolean;
  /** Where problems with the speaker are shown; set by the UI. */
  onNotice: (text: string) => void = () => {};

  constructor(speaker: Speaker, world: Voiced, enabled: boolean) {
    this.speaker = speaker;
    this.world = world;
    this.enabled = enabled;
  }

  say(lines: LogLine[]): void {
    if (this.enabled) this.speaker.speak(voiceScript(lines, this.world));
  }

  stop(): void {
    this.speaker.stop();
  }

  /** The speaker gave up: reading aloud stops, and the player is told why. */
  report(text: string): void {
    this.enabled = false;
    this.onNotice(text);
  }

  /** Returns whether it's now on: it can't be turned on if the speaker has failed. */
  setEnabled(enabled: boolean): boolean {
    this.enabled = enabled && this.speaker.available !== false;
    if (!this.enabled) this.stop();
    return this.enabled;
  }
}
