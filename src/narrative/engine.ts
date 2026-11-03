import type { CheckRequest, CheckResult, Complication, Intent, LogLine, NpcDef, Resolved, SceneView } from "../domain/types.js";
import type { ChatMessage, LlmProvider } from "../llm/provider.js";
import { pastReplies, type Recollection } from "../world/memory.js";
import type { ExchangeCandidate, ExchangeChoice, Fact } from "../world/sharing.js";
import { describeTime } from "../world/time.js";
import { checkOutcome, describeEvents, NO_DICE } from "./describe.js";
import {
  complicationMessages,
  dialogueMessages,
  exchangeMessages,
  interpretMessages,
  narrationMessages,
  type DialoguePlayer,
} from "./prompts.js";
import { repeated } from "./repetition.js";

const NOTHING_RECALLED: Recollection = { talked: [], saw: [], heard: [] };

/** A complication surfacing: what the player sees, and how the place is changed for good. */
export interface Surfaced {
  narration: string;
  lasting: string;
}

export interface NarrationRequest {
  input: string;
  intent: Intent;
  resolution: Resolved;
  /** The scene after the world engine applied the turn's events. */
  scene: SceneView;
  recent: LogLine[];
  /** What the addressed NPC remembers, for talk intents. */
  memories?: Recollection;
  /** What the addressed NPC knows of the player: their name, once learned, and what the player gave them. */
  player?: DialoguePlayer;
}

/**
 * Turns free text into intents and outcomes into prose. It reads state but never changes it:
 * the world engine has already decided what happened before narration runs.
 */
export class NarrativeEngine {
  private readonly llm: LlmProvider;
  private readonly rules: string;

  constructor(llm: LlmProvider, rules: string) {
    this.llm = llm;
    this.rules = rules;
  }

  /** `partner` is the NPC the player is mid-conversation with, if any. */
  async interpret(input: string, scene: SceneView, partner?: NpcDef): Promise<Intent> {
    const raw = await this.llm.complete({ messages: interpretMessages(input, scene, partner), json: true, temperature: 0 });
    return parseIntent(raw, input);
  }

  async narrate(request: NarrationRequest): Promise<LogLine[]> {
    const { input, intent, resolution, scene, recent, memories = NOTHING_RECALLED } = request;
    const player = request.player ?? { given: [], knowsYourName: false };
    const check = rolled(resolution);
    if (intent.kind === "talk" && resolution.npc) {
      // A roll aimed at the person spoken to decides how they take it; one aimed elsewhere isn't theirs to judge.
      const attempt = check && (!check.npcId || check.npcId === resolution.npc.id) ? check : undefined;
      const messages = dialogueMessages(this.rules, resolution.npc, scene, recent, intent.message, memories, player, attempt);
      // Example lines in their way of speaking are for the sound of it: saying one is repeating it.
      const examples = resolution.npc.speech?.match(/"[^"]+"/g) ?? [];
      const text = await this.reply(messages, [...examples, ...pastReplies(memories.talked)]);
      return [{ kind: "npc", speaker: resolution.npc.name, npcId: resolution.npc.id, text }];
    }
    const messages = narrationMessages(this.rules, scene, recent, input, outcome(intent, resolution, scene));
    const text = await this.llm.complete({ messages, temperature: 0.8 });
    return [{ kind: "narration", text: text.trim() }];
  }

  /**
   * An NPC's reply. If it says again what they've said to the player before, they're asked once more for
   * something new; the second answer stands either way.
   */
  private async reply(messages: ChatMessage[], past: string[]): Promise<string> {
    const first = (await this.llm.complete({ messages, temperature: 0.8 })).trim();
    const again = repeated(first, past);
    if (!again.length) return first;
    const retry = await this.llm.complete({
      messages: [
        ...messages,
        { role: "assistant", content: first },
        {
          role: "user",
          content: `You've said this to the stranger before: ${again.map((a) => `"${a}"`).join(", ")}. Reply again, in other words, without repeating yourself: say something new, or move the conversation on.`,
        },
      ],
      temperature: 0.9,
    });
    return retry.trim() || first;
  }

  /** Words the delayed cost of an earlier partial success, as it surfaces where the player is. */
  async surface(complication: Complication, scene: SceneView, recent: LogLine[]): Promise<Surfaced | undefined> {
    const raw = await this.llm.complete({
      messages: complicationMessages(this.rules, scene, recent, complication),
      json: {
        type: "object",
        properties: { narration: { type: "string" }, lasting: { type: "string" } },
        required: ["narration", "lasting"],
      },
      temperature: 0.8,
    });
    const data = parseObject(raw);
    const text = (key: string) => (typeof data?.[key] === "string" ? data[key].trim() : "");
    return text("narration") && text("lasting") ? { narration: text("narration"), lasting: text("lasting") } : undefined;
  }

  /**
   * Decides what two NPCs tell each other, from what the world engine allows each to share. `labels` are
   * how the player knows each of them, for the onlooker's summary.
   */
  async exchange(
    candidate: ExchangeCandidate,
    labels: { a: string; b: string },
    strangerPronouns: string,
  ): Promise<ExchangeChoice> {
    const raw = await this.llm.complete({
      messages: exchangeMessages(candidate, labels, strangerPronouns),
      json: exchangeSchema(candidate),
      temperature: 0.4,
    });
    return parseExchange(raw, candidate);
  }
}

/** Limits each side's picks to the ids it was offered. */
function exchangeSchema({ aToB, bToA }: ExchangeCandidate): Record<string, unknown> {
  const picks = (label: string, offered: Fact[]) =>
    offered.length
      ? { type: "array", items: { type: "string", enum: offered.map((_, i) => `${label}${i + 1}`) } }
      : { type: "array", maxItems: 0 };
  return {
    type: "object",
    properties: { a_tells_b: picks("A", aToB), b_tells_a: picks("B", bToA), summary: { type: "string" } },
    required: ["a_tells_b", "b_tells_a", "summary"],
  };
}

/**
 * Parses the model's choice, keeping only facts that were actually offered, so nothing hidden can leak.
 * Each pick may be an id ("A1") or, as models sometimes reply, the fact's text.
 */
export function parseExchange(raw: string, { aToB, bToA }: ExchangeCandidate): ExchangeChoice {
  const data = parseObject(raw) ?? {};
  const pick = (key: string, label: string, offered: Fact[]) => {
    const picks = (Array.isArray(data[key]) ? data[key] : []).filter((p): p is string => typeof p === "string");
    return offered.filter((fact, i) =>
      picks.some((p) => p.trim() === `${label}${i + 1}` || comparable(p) === comparable(fact.text)),
    );
  };
  return {
    aTells: pick("a_tells_b", "A", aToB),
    bTells: pick("b_tells_a", "B", bToA),
    summary: typeof data.summary === "string" ? data.summary.trim() : "",
  };
}

function outcome(intent: Intent, resolution: Resolved, scene: SceneView): string {
  const changes = describeEvents(resolution.events.filter((e) => e.type !== "checked"), scene, resolution.npc);
  const check = rolled(resolution);
  const base = changes.length
    ? changes.join(" ")
    : intent.kind === "look"
      ? "The player looks around. Nothing changes."
      : intent.kind === "wait"
        ? "The player waits a while, letting time pass. Nothing else changes."
        : intent.kind === "sleep"
          ? `The player sleeps through the night and wakes rested, now: ${describeTime(scene.time)}.`
        : "The world state does not change. Describe the attempt and its immediate result, but do not " +
          "move the player, add or remove items, change health, or resolve quests.";
  const searched = intent.kind === "search" ? searchOutcome(resolution, check) : "";
  return [base, searched, check && `${checkOutcome(check)} ${NO_DICE}`].filter(Boolean).join(" ");
}

/**
 * What a search turned up, beyond what's found (which describeEvents states): nothing, so the narrator
 * mustn't invent a find; or, when a roll partly failed, a hint that something is there.
 */
function searchOutcome(resolution: Resolved, check: CheckResult | undefined): string {
  const found = resolution.events.some((e) => e.type === "item_found");
  const missed = resolution.search && !resolution.events.some((e) => e.type === "item_found" && resolution.search!.items.some((h) => h.item === e.item));
  if (missed && check?.outcome === "partial_failure") {
    const where = resolution.search!.items.map((h) => h.hidden).filter(Boolean).join("; ");
    return `Something is hidden here${where ? ` (${where})` : ""}, but the player doesn't find it; at most they sense a hint that there's something to find. Don't name it.`;
  }
  return found ? "" : "The player searches but finds nothing. Don't invent anything they find.";
}

function rolled(resolution: Resolved): CheckResult | undefined {
  const event = resolution.events.find((e) => e.type === "checked");
  return event?.type === "checked" ? event.check : undefined;
}

/** Parses the model's JSON intent; anything malformed becomes a generic action. */
export function parseIntent(raw: string, input: string): Intent {
  const data = parseObject(raw);
  const intent = parseKind(data, input);
  const check = data && intent.kind !== "look" && intent.kind !== "wait" ? parseCheck(data.check) : undefined;
  return check ? { ...intent, check } : intent;
}

function parseCheck(value: unknown): CheckRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const data = value as Record<string, unknown>;
  const text = (key: string) => (typeof data[key] === "string" && data[key].trim() ? data[key].trim() : undefined);
  const stat = text("stat");
  const why = text("why");
  if (!stat || !why) return undefined;
  const target = text("target");
  return {
    stat: stat.toLowerCase(),
    why,
    ...(target ? { target } : {}),
    ...(data.push === true ? { push: true } : {}),
    ...(data.stealth === true ? { stealth: true } : {}),
  };
}

function parseKind(data: Record<string, unknown> | undefined, input: string): Intent {
  const fallback: Intent = { kind: "act", action: input };
  if (!data) return fallback;
  const text = (key: string) => (typeof data[key] === "string" && data[key].trim() ? data[key].trim() : undefined);

  switch (data.kind) {
    case "look":
      return { kind: "look" };
    case "wait":
      return { kind: "wait" };
    case "sleep":
      return { kind: "sleep" };
    case "search": {
      const where = text("where");
      return where ? { kind: "search", where } : { kind: "search" };
    }
    case "move": {
      const direction = text("direction");
      return direction ? { kind: "move", direction } : fallback;
    }
    case "take": {
      const listed = Array.isArray(data.items) ? data.items.filter((i): i is string => typeof i === "string" && !!i.trim()) : [];
      const items = listed.length ? listed.map((i) => i.trim()) : [text("item")].filter((i): i is string => !!i);
      return items.length ? { kind: "take", items } : fallback;
    }
    case "talk": {
      const npc = text("npc");
      return npc ? { kind: "talk", npc, message: text("message") ?? input } : fallback;
    }
    case "drop": {
      const item = text("item");
      return item ? { kind: "drop", item } : fallback;
    }
    case "give": {
      const item = text("item");
      const npc = text("npc");
      return item && npc ? { kind: "give", item, npc } : fallback;
    }
    case "act":
      return { kind: "act", action: text("action") ?? input };
    default:
      return fallback;
  }
}

/** Text compared loosely: case, quote style and surrounding punctuation don't matter. */
function comparable(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’“”"']/g, "")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

/** The JSON object in a model reply, tolerating text around it. */
function parseObject(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
