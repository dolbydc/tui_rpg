import { render, type Instance } from "ink";
import type { Game } from "../engine/api.js";
import type { Audio } from "../voice/audio.js";
import { Root } from "./root.js";

export interface TerminalStreams {
  /** A TTY-like input stream (raw mode); the process's own by default. */
  stdin?: NodeJS.ReadStream;
  /** A TTY-like output stream with `columns`, `rows` and "resize" events; the process's own by default. */
  stdout?: NodeJS.WriteStream;
  /** Draw the map, character, inventory and quests beside the log (default); off where the host draws them. */
  sidebar?: boolean;
}

/** The terminal UI over `game`, in the given terminal: this process's, or one drawn somewhere else (Electron). */
export function runTui(game: Game, audio: Pick<Audio, "voice" | "music">, { sidebar, ...streams }: TerminalStreams = {}): Instance {
  return render(<Root game={game} voice={audio.voice} music={audio.music} sidebar={sidebar} />, {
    ...streams,
    ...(streams.stdout && { stderr: streams.stdout }),
    // Somewhere else, there's no console to patch, and the host decides what Ctrl+C does.
    ...(streams.stdout && { patchConsole: false }),
  });
}
