#!/usr/bin/env node
// The engine on its own, for a frontend in another process: the Game contract over stdin and stdout (see
// protocol.ts), configured like the terminal game (config.ts). Anything else it prints goes to stderr.
import { loadConfig } from "../config.js";
import { createGame } from "./create.js";
import { serve } from "./protocol.js";

console.log = console.info = console.warn = console.error;

// A bad setting fails every request with what was wrong, rather than the process with a stack trace.
const game = Promise.resolve().then(() => createGame(loadConfig()));
game.catch((err: unknown) => console.error(err instanceof Error ? err.message : err));
await serve(game, process.stdin, process.stdout);
await game.then((g) => g.close()).catch(() => {});
