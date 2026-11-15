import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createGame } from "../engine/create.js";
import { DEFAULT_CONTENT_DIR } from "../config.js";
import { SilentSpeaker } from "../voice/speaker.js";
import { MusicPlayer } from "../voice/music.js";
import { NO_CAST, VoiceOver } from "../voice/voice-over.js";
import { RemoteTerminal } from "./terminal.js";

// Colour is decided when Ink's colouring loads, from this process's stdout; the terminal elsewhere has it.
process.env.FORCE_COLOR = "3";
const { runTui } = await import("./run.js");

/** Waits until what's been drawn matches `pattern`. */
async function until(screen: () => string, pattern: RegExp) {
  for (let i = 0; i < 100 && !pattern.test(screen()); i++) await sleep(20);
  assert.match(screen(), pattern);
}

test("the terminal UI plays in a terminal drawn elsewhere: keys in, frames out", async () => {
  let drawn = "";
  const terminal = new RemoteTerminal((data) => (drawn += data), { columns: 120, rows: 40 });
  const game = await createGame({ contentDir: DEFAULT_CONTENT_DIR, storage: "memory", sqliteFile: "", llm: "mock", ollamaUrl: "", ollamaModel: "" });
  const audio = { voice: new VoiceOver(new SilentSpeaker(), NO_CAST, false), music: new MusicPlayer({ enabled: false }) };
  const app = runTui(game, audio, terminal);
  try {
    await until(() => drawn, /New game[\s\S]*The Hollow Lantern/);
    assert.match(drawn, /\x1b\[3\dm/, "in colour");
    terminal.input("\r");
    await until(() => drawn, /What is your character's name\?/);
    drawn = "";
    terminal.resize(100, 30);
    await until(() => drawn, /What is your character's name\?/);
    terminal.input("\x1b"); // Esc quits
    await app.waitUntilExit();
  } finally {
    app.unmount();
    await game.close();
  }
});

test("where the host draws the panels, the terminal UI draws only the story", async () => {
  let drawn = "";
  const terminal = new RemoteTerminal((data) => (drawn += data), { columns: 120, rows: 30 });
  const game = await createGame({ contentDir: DEFAULT_CONTENT_DIR, storage: "memory", sqliteFile: "", llm: "mock", ollamaUrl: "", ollamaModel: "" });
  const audio = { voice: new VoiceOver(new SilentSpeaker(), NO_CAST, false), music: new MusicPlayer({ enabled: false }) };
  const app = runTui(game, audio, { stdin: terminal.stdin, stdout: terminal.stdout, sidebar: false });
  try {
    await until(() => drawn, /New game/);
    terminal.input("\r");
    // Each answer once its question has been asked.
    for (const [question, answer] of [[/character's name\?/, "Ash"], [/pronouns\?/, "they"], [/points/, "3 3 2 2"], [/Begin with this character\?/, "yes"]] as const) {
      await until(() => drawn, question);
      terminal.input(answer + "\r");
    }
    await until(() => drawn, /Brackenford Square/);
    await sleep(100);
    assert.doesNotMatch(drawn, /Inventory|Quests|Map/);
  } finally {
    app.unmount();
    await game.close();
  }
});
