import { Box, Text, Transform, type TextProps } from "ink";
import type { Character, LogLine, MapView, Quest } from "../domain/types.js";
import type { PlayerStatus } from "../game/session.js";
import type { LineState } from "./line-editor.js";
import { formatBonus, statBonus } from "../world/checks.js";
import { clock } from "../world/time.js";
import { cellsAcross, renderMap, type Glyph, type GlyphStyle } from "./map-grid.js";

const LOG_LIMIT = 60;

export function DialogueLog({ title, lines, busy }: { title: string; lines: LogLine[]; busy: boolean }) {
  return (
    // flexBasis 0: take exactly the width left beside the sidebar. Sized from its content instead, the log
    // shrinks to a fractional width, and text wrapped to the rounded-up width loses its last column.
    <Box flexDirection="column" flexGrow={1} flexBasis={0} borderStyle="round" paddingX={1} overflow="hidden">
      <Box flexShrink={0}>
        <Text bold color="cyan">
          {title}
        </Text>
      </Box>
      {/* Anchored to the bottom so the newest lines stay visible; older ones clip off the top. Entries
          mustn't shrink, or an overfull log squeezes every entry and cuts off the end of each. */}
      <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden">
        {lines.slice(-LOG_LIMIT).map((line, i) => (
          <Box key={i} flexShrink={0} marginTop={line.kind === "player" ? 1 : 0}>
            <Transform transform={trimWrappedRow}>
              <Line line={line} />
            </Transform>
          </Box>
        ))}
        {busy && <Text dimColor>…</Text>}
      </Box>
    </Box>
  );
}

/** Ink keeps the space at a line break, so wrapped rows would start one column in; drop it (after any styling). */
function trimWrappedRow(row: string, index: number): string {
  return index === 0 ? row : row.replace(/^((?:\x1b\[[0-9;]*m)*) /, "$1");
}

function Line({ line }: { line: LogLine }) {
  switch (line.kind) {
    case "player":
      return <Text color="yellow">&gt; {line.text}</Text>;
    case "npc":
      return (
        <Text>
          <Text bold color="cyan">
            {line.speaker}:
          </Text>{" "}
          {line.text}
        </Text>
      );
    case "system":
      return <Text dimColor>{line.text}</Text>;
    case "error":
      return <Text color="red">{line.text}</Text>;
    default:
      return <Text>{line.text}</Text>;
  }
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      {children}
    </Box>
  );
}

const MAP_STYLES: Record<GlyphStyle, TextProps> = {
  border: { dimColor: true },
  here: { color: "cyan" },
  link: { dimColor: true },
  label: { dimColor: true },
  hereLabel: { bold: true },
  player: { color: "yellow", bold: true },
  person: { color: "cyan" },
  item: { color: "green" },
  stairs: { color: "yellow" },
};

/** The places the player has been, `width` characters wide (borders included) and up to `rows` places tall. */
export function MapPanel({ map, width, rows }: { map: MapView; width: number; rows: number }) {
  const grid = renderMap(map, cellsAcross(width - 2), rows);
  return (
    <Box flexDirection="column" borderStyle="round" width={width} flexShrink={0}>
      <Box paddingX={1}>
        <Text bold color="cyan">
          Map
        </Text>
        {map.level !== 0 && <Text dimColor> · {map.level < 0 ? `${-map.level} below ground` : `${map.level} up`}</Text>}
      </Box>
      {grid.map((row, i) => (
        <Text key={i} wrap="truncate">
          {runs(row).map((run, j) => (
            <Text key={j} {...(run.style && MAP_STYLES[run.style])}>
              {run.text}
            </Text>
          ))}
        </Text>
      ))}
      <Box paddingX={1}>
        <Text dimColor wrap="truncate">
          @ you ? someone • item ▲▼ stairs
        </Text>
      </Box>
    </Box>
  );
}

/** Neighbouring glyphs of the same style, joined so each row is a few Text runs rather than one per character. */
function runs(row: Glyph[]): { text: string; style?: GlyphStyle }[] {
  const out: { text: string; style?: GlyphStyle }[] = [];
  for (const { ch, style } of row) {
    const last = out.at(-1);
    if (last && last.style === style) last.text += ch;
    else out.push({ text: ch, style });
  }
  return out;
}

export function CharacterSheet({ character, status }: { character: Character; status: PlayerStatus }) {
  const spent = status.actionsPerTurn - status.actionsLeft;
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1} flexShrink={0}>
      <Text wrap="truncate">
        <Text bold color="cyan">
          {character.name}
        </Text>{" "}
        <Text dimColor>({character.pronouns})</Text>
      </Text>
      <Text>
        HP{" "}
        <Text color={character.hp * 3 <= character.maxHp ? "red" : "green"}>
          {character.hp}/{character.maxHp}
        </Text>
      </Text>
      <Text>
        Level <Text bold>{character.level}</Text>
        {"   "}XP{" "}
        <Text color={character.xp >= status.nextLevelXp ? "yellow" : undefined}>
          {character.xp}/{status.nextLevelXp}
        </Text>
        {character.xp >= status.nextLevelXp && <Text color="yellow"> /levelup</Text>}
      </Text>
      {/* Two stats a row, each with its bonus to rolls. */}
      {pairs(Object.entries(character.stats).sort(([a], [b]) => a.localeCompare(b))).map((row, i) => (
        <Text key={i} wrap="truncate">
          {row.map(([stat, value], j) => (
            <Text key={stat}>
              {j ? "  " : ""}
              {stat.padEnd(8)} {String(value).padStart(2)} <Text dimColor>{formatBonus(statBonus(value))}</Text>
            </Text>
          ))}
        </Text>
      ))}
      <Text>
        Day {status.time.day} · {status.time.phase} <Text dimColor>{clock(status.time.minutes)}</Text>
      </Text>
      <Text>
        Turn <Text bold>{status.turn}</Text>
        {"  "}Actions <Text color="green">{"●".repeat(status.actionsLeft)}</Text>
        <Text dimColor>{"○".repeat(spent)}</Text>
        {"  "}Drive <Text color="magenta">{"◆".repeat(status.drive)}</Text>
        <Text dimColor>{"◇".repeat(Math.max(status.drivePerQuest - status.drive, 0))}</Text>
      </Text>
    </Box>
  );
}

function pairs<T>(items: T[]): T[][] {
  return Array.from({ length: Math.ceil(items.length / 2) }, (_, i) => items.slice(i * 2, i * 2 + 2));
}

export function Inventory({ items }: { items: string[] }) {
  return (
    <Panel title="Inventory">
      {items.length ? items.map((item, i) => <Text key={i}>• {item}</Text>) : <Text dimColor>(empty)</Text>}
    </Panel>
  );
}

export function QuestLog({ quests }: { quests: Quest[] }) {
  return (
    <Panel title="Quests">
      {quests.some((q) => q.status !== "pending") ? (
        quests.filter((q) => q.status !== "pending").map((quest) => (
          <Text key={quest.id} dimColor={quest.status === "completed"}>
            {quest.status === "completed" ? "✓" : "•"} {quest.title}
          </Text>
        ))
      ) : (
        <Text dimColor>(none)</Text>
      )}
    </Panel>
  );
}

export function InputLine({ line, busy }: { line: LineState; busy: boolean }) {
  const { text, cursor } = line;
  return (
    <Box paddingX={1}>
      <Text color="yellow">&gt; </Text>
      {busy ? (
        <Text dimColor>thinking…</Text>
      ) : (
        // The cursor is drawn as the character under it in inverse (a space at the end of the line).
        <Text>
          {text.slice(0, cursor)}
          <Text inverse>{text[cursor] ?? " "}</Text>
          {text.slice(cursor + 1)}
        </Text>
      )}
    </Box>
  );
}
