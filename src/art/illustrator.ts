// Pictures drawn as the player goes: of each place the first time they arrive somewhere that has none of its own,
// and a portrait of each person the first time they see them. The language model turns what the player can see
// (a place's description, a person's appearance) into a prompt for an image model, and a Painter (ComfyUI)
// draws it. Each is drawn once and kept, so going back, or carrying on another day, shows it straight away.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LocationDef, NpcDef, WorldDefinition } from "../domain/types.js";
import type { LlmProvider } from "../llm/provider.js";
import type { Painter, Shape } from "./comfy.js";

/** For campaigns that don't say how their pictures should look (`art_style` in world.md). */
const DEFAULT_STYLE = "atmospheric digital concept art, cinematic lighting, rich detail";

/** What a picture is of: a place, or a person (an NPC). */
export interface Subject {
  kind: "place" | "person";
  id: string;
}

export interface IllustratorOptions {
  painter: Painter;
  /** Writes the image model's prompt from what's to be drawn. */
  llm: LlmProvider;
  /** Where pictures are kept: <dir>/<campaign>/<location>.png, and <dir>/<campaign>/people/<npc>.png. */
  dir: string;
  /** A picture is ready. */
  onReady?: (campaignId: string, subject: Subject, file: string) => void;
  /** Drawing failed (ComfyUI isn't running, say). Told once: after that no more are drawn. */
  onError?: (err: Error) => void;
}

interface Job {
  campaignId: string;
  world: WorldDefinition;
  subject: Subject;
}

export class Illustrator {
  /** Waiting to be drawn, by file, oldest first. */
  private readonly queue = new Map<string, Job>();
  private drawing?: string;
  private failed = false;
  private readonly stopped = new AbortController();

  constructor(private readonly options: IllustratorOptions) {}

  /** Where a picture is kept. */
  file(campaignId: string, { kind, id }: Subject): string {
    return kind === "place" ? path.join(this.options.dir, campaignId, `${id}.png`) : path.join(this.options.dir, campaignId, "people", `${id}.png`);
  }

  /** The picture, if it's been drawn (nothing more). */
  drawn(campaignId: string, subject: Subject): string | undefined {
    const file = this.file(campaignId, subject);
    return existsSync(file) ? file : undefined;
  }

  /** The picture, if it's been drawn; if not, it's drawn (in the background) and onReady says when. */
  picture(campaignId: string, world: WorldDefinition, subject: Subject): string | undefined {
    const file = this.file(campaignId, subject);
    if (existsSync(file)) return file;
    const known = subject.kind === "place" ? world.locations.has(subject.id) : world.npcs.has(subject.id);
    if (!known || this.failed || this.stopped.signal.aborted || this.drawing === file) return undefined;
    this.queue.delete(file); // to the back: the latest asked for is drawn first
    this.queue.set(file, { campaignId, world, subject });
    if (!this.drawing) void this.work();
    return undefined;
  }

  /** Whether a picture is being drawn, or waiting to be. */
  pending(campaignId: string, subject: Subject): boolean {
    const file = this.file(campaignId, subject);
    return this.drawing === file || this.queue.has(file);
  }

  /** Stops drawing; what's being drawn is abandoned. */
  close(): void {
    this.stopped.abort();
    this.queue.clear();
  }

  /** Next to draw: the place asked for most recently, then the person; where the player is matters most. */
  private next(): [string, Job] {
    const waiting = [...this.queue];
    return waiting.findLast(([, job]) => job.subject.kind === "place") ?? waiting.at(-1)!;
  }

  private async work(): Promise<void> {
    while (this.queue.size && !this.failed && !this.stopped.signal.aborted) {
      const [file, job] = this.next();
      this.queue.delete(file);
      this.drawing = file;
      let failure: unknown;
      try {
        await this.draw(file, job);
      } catch (err) {
        failure = err ?? new Error("drawing failed");
      }
      // Done with it before anyone's told, so they see it as drawn, or as not on its way any more.
      this.drawing = undefined;
      if (this.stopped.signal.aborted) break;
      if (failure === undefined) {
        this.options.onReady?.(job.campaignId, job.subject, file);
        continue;
      }
      this.failed = true;
      this.queue.clear();
      this.options.onError?.(failure instanceof Error ? failure : new Error(String(failure)));
    }
  }

  private async draw(file: string, { campaignId, world, subject }: Job): Promise<void> {
    const signal = this.stopped.signal;
    const [prompt, shape]: [string, Shape] =
      subject.kind === "place"
        ? [await imagePrompt(this.options.llm, world, world.locations.get(subject.id)!, signal), "landscape"]
        : [await portraitPrompt(this.options.llm, world, world.npcs.get(subject.id)!, signal), "portrait"];
    const key = subject.kind === "place" ? `${campaignId}/${subject.id}` : `${campaignId}/people/${subject.id}`;
    const png = await this.options.painter.draw(prompt, seedOf(key), { signal, shape });
    signal.throwIfAborted(); // closed while it was drawn: nothing is written after that
    await mkdir(path.dirname(file), { recursive: true });
    // The prompt is kept beside the picture, to see why it looks the way it does (delete both to redraw).
    await writeFile(file.replace(/\.png$/, ".prompt.txt"), prompt + "\n");
    // Written whole and then moved into place, so a half-written picture is never shown.
    await writeFile(`${file}.part`, png);
    await rename(`${file}.part`, file);
  }
}

/**
 * The image model's prompt for a place: what can be seen there, from back to front, its light and mood, then
 * the campaign's art style. No people (the place is drawn once, and who's there changes), no lettering, and
 * nothing the description doesn't show (hidden items stay hidden: they're never in it).
 */
export function imagePrompt(llm: LlmProvider, world: WorldDefinition, location: LocationDef, signal?: AbortSignal): Promise<string> {
  return writePrompt(
    llm,
    world,
    "You write prompts for a text-to-image model that illustrates places in a text adventure.\n" +
      (world.artDetail === "simple"
        ? "The prompt is one short paragraph of 25-45 words in plain visual language: the setting, its two or three " +
          "biggest shapes, the main light and the mood. Keep it simple and uncluttered: broad shapes, no small objects, " +
          "no fine texture or intricate detail. "
        : "The prompt is one paragraph of 60-110 words in plain visual language: the setting; what is in the foreground, " +
          "middle and background; the light sources and their colour; the time of day and the weather; the mood. ") +
      "Describe only what can be seen there. No people or creatures, no names, no story, no text, signs or lettering.",
    `The place: ${location.name}\n${location.description}`,
    `${location.name}. ${location.description}`,
    signal,
  );
}

/**
 * The image model's prompt for a portrait of someone, from how they look to someone who doesn't know them. Their
 * persona, knowledge and name never go in, so nothing they keep to themselves can show in the picture.
 */
export function portraitPrompt(llm: LlmProvider, world: WorldDefinition, npc: NpcDef, signal?: AbortSignal): Promise<string> {
  return writePrompt(
    llm,
    world,
    "You write prompts for a text-to-image model that paints character portraits for a text adventure.\n" +
      (world.artDetail === "simple"
        ? "The prompt is one short paragraph of 20-40 words in plain visual language: a head-and-shoulders portrait of one " +
          "person facing the viewer; their age, face, hair, expression and the main colours of their clothes; a plain, empty, " +
          "flat grey background. Keep it simple: bold shapes, no fine texture or intricate detail. "
        : "The prompt is one paragraph of 50-90 words in plain visual language: a head-and-shoulders portrait of one person " +
          "facing the viewer; their age, build, face, hair, expression and clothes; soft, even light on them; a plain, " +
          "empty, flat grey background. ") +
      // They're cut out and shown over wherever they are now, which a room or landscape behind them would contradict.
      "Nothing behind them: no room, no scenery, no props. Only what can be seen: no names, no story, no other people, " +
      "no text or lettering.",
    `The person (${npc.pronouns}): ${npc.appearance}`,
    `Head-and-shoulders portrait of ${npc.appearance}, facing the viewer, plain empty grey background`,
    signal,
  );
}

async function writePrompt(
  llm: LlmProvider,
  world: WorldDefinition,
  system: string,
  subject: string,
  fallback: string,
  signal?: AbortSignal,
): Promise<string> {
  const reply = await llm.complete({
    json: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"] },
    temperature: 0.6,
    signal,
    messages: [
      { role: "system", content: `${system}\nReply as JSON: {"prompt": "..."}.` },
      { role: "user", content: `The campaign's tone:\n${world.rules.slice(0, 600)}\n\n${subject}` },
    ],
  });
  let prompt = "";
  try {
    const parsed = JSON.parse(reply) as { prompt?: unknown };
    if (typeof parsed.prompt === "string") prompt = parsed.prompt.trim();
  } catch {
    // fall back to what was given
  }
  if (prompt.split(/\s+/).length < 12) prompt = fallback;
  return `${prompt.replace(/[.\s]+$/, "")}. ${world.artStyle ?? DEFAULT_STYLE}`;
}

/** The same seed for the same picture every time, so redrawing it gives the same picture. */
function seedOf(key: string): number {
  return createHash("sha256").update(key).digest().readUIntBE(0, 6);
}
