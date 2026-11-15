import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RemoteGame } from "./protocol.js";

export interface SpawnOptions {
  /** The Node.js to run it with (the engine's native modules are built for it): `node` on the PATH by default. */
  node?: string;
  env?: NodeJS.ProcessEnv;
  /** What the engine prints besides its answers: its startup errors, say. */
  onLog?: (text: string) => void;
}

/** Starts the engine (host.js, built) in a Node.js process of its own, and connects to it. */
export function spawnEngine({ node = "node", env = process.env, onLog = () => {} }: SpawnOptions = {}): RemoteGame {
  const host = fileURLToPath(new URL("./host.js", import.meta.url));
  const child = spawn(node, [host], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.setEncoding("utf8").on("data", onLog);
  // Disconnected when the process has gone (below), so the reason can say why.
  const game = new RemoteGame(child.stdout, child.stdin, { ended: false });
  let stderr = "";
  child.stderr.on("data", (text: string) => (stderr = (stderr + text).slice(-2000)));
  child.on("error", (err) => game.disconnect(new Error(`Couldn't start the game engine with ${node}: ${err.message}`)));
  child.on("close", (code) => {
    const why = code ? (stderr.trim() ? `: ${stderr.trim()}` : ` (exit code ${code})`) : "";
    game.disconnect(new Error(`The game engine has stopped${why}`));
  });
  // Writing to an engine that has just stopped fails the call (as above), not the frontend.
  child.stdin.on("error", () => {});
  return game;
}
