#!/usr/bin/env node
// The terminal game: the engine in this process, drawn in this terminal.
import { loadConfig } from "./config.js";
import { createGame } from "./engine/create.js";
import { runTui } from "./tui/run.js";
import { createAudio } from "./voice/audio.js";

async function main() {
  const config = loadConfig();
  const game = await createGame(config);
  const audio = createAudio(config);
  const app = runTui(game, audio);
  await app.waitUntilExit();
  await audio.close();
  await game.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
