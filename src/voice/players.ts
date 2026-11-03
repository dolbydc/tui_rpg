import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** One line of audio playing. `done` settles when it finishes or is stopped, and rejects if it can't play. */
export interface Playback {
  done: Promise<void>;
  stop(): void;
}

/** Plays mono audio through whatever the system has. */
export interface AudioPlayer {
  readonly name: string;
  play(samples: Float32Array, rate: number): Playback;
  close(): void;
}

/** Players by name, for TUI_RPG_PLAYER. */
export const PLAYERS = ["paplay", "pw-play", "aplay", "afplay", "powershell"] as const;
export type PlayerName = (typeof PLAYERS)[number];

/**
 * The player for this system: afplay on macOS, PowerShell's SoundPlayer on Windows, and on Linux (WSL
 * included, where WSLg routes PulseAudio to Windows) the first installed of paplay (PulseAudio, or
 * PipeWire's stand-in for it), pw-play (PipeWire) and aplay (ALSA). `choice` (TUI_RPG_PLAYER) picks one
 * outright.
 */
export function systemPlayer(platform: NodeJS.Platform = process.platform, choice?: PlayerName): AudioPlayer {
  if (choice) return player(choice);
  if (platform === "darwin") return player("afplay");
  if (platform === "win32") return player("powershell");
  return new FallbackPlayer([player("paplay"), player("pw-play"), player("aplay")]);
}

function player(name: PlayerName): AudioPlayer {
  switch (name) {
    case "paplay":
      return new PipePlayer(name, (rate) => ["--raw", "--format=float32le", `--rate=${rate}`, "--channels=1"], raw);
    case "aplay":
      return new PipePlayer(name, (rate) => ["-q", "-t", "raw", "-f", "FLOAT_LE", "-r", String(rate), "-c", "1"], raw);
    case "pw-play":
    case "afplay":
      return new FilePlayer(name);
    case "powershell":
      return new PowerShellPlayer();
  }
}

/** Audio piped to a command's stdin. */
class PipePlayer implements AudioPlayer {
  constructor(
    readonly name: string,
    private readonly args: (rate: number) => string[],
    private readonly encode: (samples: Float32Array, rate: number) => Buffer,
    private readonly command = name,
  ) {}

  play(samples: Float32Array, rate: number): Playback {
    const child = spawn(this.command, this.args(rate), { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin?.on("error", () => {}); // killed mid-line
    child.stdin?.end(this.encode(samples, rate));
    return playback(child, this.name);
  }

  close(): void {}
}

/** For players that play files, not stdin (afplay, pw-play): each line goes through a temporary WAV file. */
class FilePlayer implements AudioPlayer {
  constructor(readonly name: string) {}

  play(samples: Float32Array, rate: number): Playback {
    const file = path.join(tmpdir(), `tui-rpg-${randomUUID()}.wav`);
    let child: ChildProcess | undefined;
    let stopped = false;
    const done = writeFile(file, wav(samples, rate))
      .then(() => {
        if (stopped) return;
        child = spawn(this.name, [file], { stdio: "ignore" });
        return playback(child, this.name).done;
      })
      .finally(() => unlink(file).catch(() => {}));
    return {
      done,
      stop: () => {
        stopped = true;
        child?.kill();
      },
    };
  }

  close(): void {}
}

/**
 * Reads a WAV file from stdin and plays it with .NET's SoundPlayer, which every Windows has. Stdin is read
 * in full first: SoundPlayer wants a stream it can measure.
 */
const POWERSHELL_PLAY =
  "$m = New-Object IO.MemoryStream; [Console]::OpenStandardInput().CopyTo($m); $m.Position = 0; " +
  "(New-Object Media.SoundPlayer $m).PlaySync()";

/**
 * Windows: PowerShell's SoundPlayer. PowerShell takes the best part of half a second to start, so one is
 * always started ahead, waiting for the next line, and lines follow each other without a gap.
 */
class PowerShellPlayer implements AudioPlayer {
  readonly name = "powershell";
  private spare?: ChildProcess;

  constructor(private readonly command = "powershell.exe") {}

  play(samples: Float32Array, rate: number): Playback {
    const child = this.spare ?? this.start();
    this.spare = this.start();
    child.stdin?.on("error", () => {});
    child.stdin?.end(wav(samples, rate));
    return playback(child, this.name);
  }

  close(): void {
    this.spare?.kill();
    this.spare = undefined;
  }

  private start(): ChildProcess {
    const child = spawn(this.command, ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_PLAY], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    // A spare that fails to start reports it when it's used.
    child.on("error", () => {});
    return child;
  }
}

/** The first player that's installed: if one isn't there, the next is tried, and kept from then on. */
export class FallbackPlayer implements AudioPlayer {
  constructor(private readonly players: AudioPlayer[]) {}

  get name(): string {
    return this.players[0].name;
  }

  play(samples: Float32Array, rate: number): Playback {
    let current = this.players[0].play(samples, rate);
    const done: Promise<void> = current.done.catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT" || this.players.length === 1) throw err;
      this.players.shift();
      current = this.play(samples, rate);
      return current.done;
    });
    return { done, stop: () => current.stop() };
  }

  close(): void {
    for (const p of this.players) p.close();
  }
}

/**
 * A running player as a Playback. It rejects if the command can't be started (ENOENT: not installed) or
 * exits with an error by itself; being killed by stop() just ends the line.
 */
function playback(child: ChildProcess, name: string): Playback {
  let stopped = false;
  const done = new Promise<void>((resolve, reject) => {
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(Object.assign(new Error(err.code === "ENOENT" ? `${name} isn't installed` : err.message), { code: err.code })),
    );
    child.on("close", (code) => (stopped || code === 0 || code === null ? resolve() : reject(new Error(`${name} exited with code ${code}`))));
  });
  return {
    done,
    stop: () => {
      stopped = true;
      child.kill();
    },
  };
}

function raw(samples: Float32Array): Buffer {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
}

/** 16-bit PCM WAV: what SoundPlayer and afplay both play. */
export function wav(samples: Float32Array, rate: number): Buffer {
  const data = samples.length * 2;
  const out = Buffer.alloc(44 + data);
  out.write("RIFF", 0);
  out.writeUInt32LE(36 + data, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(16, 16); // fmt chunk size
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28); // bytes per second
  out.writeUInt16LE(2, 32); // bytes per frame
  out.writeUInt16LE(16, 34); // bits per sample
  out.write("data", 36);
  out.writeUInt32LE(data, 40);
  samples.forEach((s, i) => out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 0x7fff), 44 + i * 2));
  return out;
}

/** For tests: the Windows player through a given PowerShell (powershell.exe from WSL, say). */
export function powerShellPlayer(command: string): AudioPlayer {
  return new PowerShellPlayer(command);
}
