import type { Intent } from "../domain/types.js";
import { ACTIONS_PER_TURN, XP_PER_LEVEL } from "../world/engine.js";
import { QUICK_TURN_SECONDS, TURN_SECONDS } from "../world/time.js";

export type Command =
  | { kind: "intent"; intent: Intent }
  | { kind: "help" }
  | { kind: "new" }
  | { kind: "quit" }
  | { kind: "memories"; npc: string }
  | { kind: "levelup"; stat?: string }
  | { kind: "cancel" }
  | { kind: "push"; text: string }
  | { kind: "voice"; on?: boolean }
  | { kind: "invalid"; message: string };

export const HELP = `Type anything to act; the narrator interprets it.
Each turn you have ${ACTIONS_PER_TURN} actions: moving, talking, taking (one item), giving or anything else costs one;
looking around is free. People move about between turns. A turn is ${TURN_SECONDS / 60} minutes, or ${QUICK_TURN_SECONDS} seconds
while you're in a conversation or a confrontation.
Commands: /look  /search [where]  /go <exit>  /take <item>  /drop <item>  /give <item> to <name>  /talk <name> <message>
          /wait (end the turn)  /sleep (until morning; restores HP)  /levelup <stat> (spend XP)  /new (new character and campaign)  /help  /quit
Risky attempts (lying, fighting, sneaking, keeping your nerve) are settled by a hidden roll: the best of
2d6 plus your stat's bonus; you only see how the story goes. Push one (/push <what you do>, or say you
give it everything) to spend a drive and roll 3d6 instead. Drive is restored when a new quest starts. Completing a quest earns its reward and experience; spend ${XP_PER_LEVEL} XP × your level to level up.
Voice: /voice on|off reads narration and dialogue aloud; Tab skips what's being said.
Debug: /memories <name> shows what an NPC remembers.`;

/** Parses a slash command. Returns undefined for free text, which goes to the narrative engine. */
export function parseCommand(input: string): Command | undefined {
  if (!input.startsWith("/")) return undefined;
  const [name = "", ...args] = input.slice(1).trim().split(/\s+/);
  const rest = args.join(" ");
  const needs = (usage: string) => ({ kind: "invalid", message: `Usage: ${usage}` }) as const;

  switch (name.toLowerCase()) {
    case "look":
    case "l":
      return { kind: "intent", intent: { kind: "look" } };
    case "go":
      return rest ? { kind: "intent", intent: { kind: "move", direction: rest } } : needs("/go <exit>");
    case "take":
      return rest
        ? { kind: "intent", intent: { kind: "take", items: rest.split(/\s*(?:,|\band\b)\s*/i).filter(Boolean) } }
        : needs("/take <item>");
    case "drop":
      return rest ? { kind: "intent", intent: { kind: "drop", item: rest } } : needs("/drop <item>");
    case "give": {
      const match = /^(.+?)\s+to\s+(.+)$/i.exec(rest);
      return match
        ? { kind: "intent", intent: { kind: "give", item: match[1], npc: match[2] } }
        : needs("/give <item> to <name>");
    }
    case "talk": {
      const [npc, ...message] = args;
      return npc && message.length
        ? { kind: "intent", intent: { kind: "talk", npc, message: message.join(" ") } }
        : needs("/talk <name> <message>");
    }
    case "wait":
    case "end":
      return { kind: "intent", intent: { kind: "wait" } };
    case "sleep":
      return { kind: "intent", intent: { kind: "sleep" } };
    case "search":
      return { kind: "intent", intent: rest ? { kind: "search", where: rest } : { kind: "search" } };
    case "levelup":
    case "level":
      return { kind: "levelup", stat: rest || undefined };
    case "memories":
      return rest ? { kind: "memories", npc: rest } : needs("/memories <name>");
    case "help":
    case "?":
      return { kind: "help" };
    case "new":
      return { kind: "new" };
    case "cancel":
      return { kind: "cancel" };
    case "voice":
      if (!rest) return { kind: "voice" };
      return /^(on|off)$/i.test(rest) ? { kind: "voice", on: rest.toLowerCase() === "on" } : needs("/voice [on|off]");
    case "push":
      return rest ? { kind: "push", text: rest } : needs("/push <what you do>");
    case "quit":
    case "q":
      return { kind: "quit" };
    default:
      return { kind: "invalid", message: `Unknown command /${name}. Type /help for commands.` };
  }
}
