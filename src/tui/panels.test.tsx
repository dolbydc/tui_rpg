import assert from "node:assert/strict";
import { test } from "node:test";
import { Box, renderToString } from "ink";
import type { LogLine } from "../domain/types.js";
import { DialogueLog, InputLine, Inventory } from "./panels.js";

const PROSE =
  "Rain has followed you for three days down the old drover's road. Tonight it finally lets up as you " +
  "reach Brackenford, a huddle of slate roofs at the edge of the Thornwood. Above the inn door hangs an " +
  "empty iron hook where, everyone says, a lantern has burned for a hundred years.";

/** The rows inside the log panel's borders, laid out as in the app. */
function logRows(lines: LogLine[], columns: number, height: number): string[] {
  const output = renderToString(
    <Box height={height}>
      <DialogueLog title="Brackenford Square" lines={lines} busy={false} />
      <Box flexDirection="column" width={30} flexShrink={0}>
        <Inventory items={["shard of lantern glass"]} />
      </Box>
    </Box>,
    { columns },
  );
  return output
    .split("\n")
    .slice(1, -1)
    .map((row) => (row.split("│")[1] ?? "").slice(1).trimEnd());
}

const joined = (rows: string[]) => rows.join(" ").replace(/\s+/g, " ");

for (const columns of [60, 80, 110, 137]) {
  test(`log text wraps without losing characters at ${columns} columns`, () => {
    const rows = logRows(
      [
        { kind: "narration", text: PROSE },
        { kind: "npc", speaker: "Old Pell", text: PROSE },
        { kind: "player", text: PROSE },
      ],
      columns,
      80,
    );
    const text = joined(rows);
    assert.ok(text.includes(PROSE), `narration was cut:\n${rows.join("\n")}`);
    assert.ok(text.includes(`Old Pell: ${PROSE}`), `NPC line was cut:\n${rows.join("\n")}`);
    assert.ok(text.includes(`> ${PROSE}`), `player line was cut:\n${rows.join("\n")}`);
    assert.ok(!rows.some((row) => row.startsWith(" ")), `a wrapped row starts with a space:\n${rows.join("\n")}`);
  });
}

test("an overfull log drops the oldest entries whole and keeps the title and newest entry intact", () => {
  const lines: LogLine[] = [1, 2, 3, 4, 5].map((n) => ({ kind: "narration", text: `Entry ${n}. ${PROSE}` }));
  const rows = logRows(lines, 80, 14);
  assert.equal(rows[0], "Brackenford Square");
  assert.ok(joined(rows).endsWith(`Entry 5. ${PROSE}`), rows.join("\n"));
  assert.ok(!joined(rows).includes("Entry 1."), rows.join("\n"));
});

test("the input line keeps its text whole wherever the cursor is", () => {
  // (The cursor itself is inverse video, which renderToString drops without a colour terminal.)
  const render = (cursor: number) => renderToString(<InputLine line={{ text: "go east", cursor }} busy={false} />);
  for (const cursor of [0, 3, 7]) assert.equal(render(cursor).trim(), "> go east");
});
