import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { render } from "ink";
import { DEFAULT_CONTENT_DIR } from "../config.js";
import { createGame } from "../engine/create.js";
import { MusicPlayer } from "../voice/music.js";
import { SilentSpeaker } from "../voice/speaker.js";
import { NO_CAST, VoiceOver } from "../voice/voice-over.js";
import { App } from "./app.js";
import { RemoteTerminal } from "./terminal.js";

const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

for (const sidebar of [false, true]) {
  test(`in a short terminal, a long story is cut at the top and the input line stays at the bottom (sidebar ${sidebar ? "on" : "off"})`, async () => {
    const rows = sidebar ? 20 : 12;
    let drawn = "";
    const terminal = new RemoteTerminal((data) => (drawn += data), { columns: 100, rows });
    const game = await createGame({ contentDir: DEFAULT_CONTENT_DIR, storage: "memory", sqliteFile: "", llm: "mock", ollamaUrl: "", ollamaModel: "" });
    await game.open("hollow-lantern", "new");
    for (const answer of ["Ash", "they", "3 3 2 2"]) await game.submit(answer);
    const opened = { lines: (await game.submit("yes")).lines, resumed: false, view: (await game.submit("/look")).view, cast: NO_CAST };
    const audio = { voice: new VoiceOver(new SilentSpeaker(), NO_CAST, false), music: new MusicPlayer({ enabled: false }) };
    // debug: every frame is written whole, so the last one can be read back.
    const app = render(<App game={game} opened={opened} {...audio} onMenu={() => {}} sidebar={sidebar} />, {
      stdin: terminal.stdin,
      stdout: terminal.stdout,
      patchConsole: false,
      debug: true,
    });
    try {
      await sleep(200);
      for (const typed of ["/look", "/look"]) {
        terminal.input(typed + "\r");
        await sleep(200);
      }
      const frame = strip(drawn).split("\n").slice(-(rows - 1));
      assert.match(frame.at(-1)!, /^ >( |$)/, `the input line is the frame's last line:\n${frame.join("\n")}`);
      assert.match(frame.at(-2)!, /╰/, "under the story's box");
      assert.match(frame.join("\n"), /You see: torn notice/, "the latest of the story shows");
    } finally {
      app.unmount();
      await game.close();
    }
  });
}
