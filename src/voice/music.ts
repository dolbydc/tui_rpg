import { spawn, type ChildProcess } from "node:child_process";
import type { PlayerName } from "./players.js";

/** How to play one file through a command. */
export interface MusicCommand {
  name: string;
  command: string;
  args: string[];
}

/**
 * A track that ends sooner than this after starting didn't really play. Now and then one does (WSLg's
 * sound server, waking up, can end the first paplay at once), but this many in a row is a broken file.
 */
const SHORTEST_LOOP_MS = 1000;
const QUICK_ENDS = 3;

/**
 * The commands that can play `file` at `volume` (0–1) on this system, best first: as for speech (see
 * systemPlayer), afplay on macOS, PowerShell on Windows (Windows Media Player, so MP3s play too), and on
 * Linux paplay, pw-play or aplay (WAV only, at full volume), whichever is installed.
 */
export function musicCommands(file: string, volume: number, platform: NodeJS.Platform = process.platform, choice?: PlayerName): MusicCommand[] {
  const command = (name: PlayerName): MusicCommand => {
    switch (name) {
      case "afplay":
        return { name, command: name, args: ["-v", String(volume), file] };
      case "paplay":
        return { name, command: name, args: [`--volume=${Math.round(volume * 65536)}`, file] };
      case "pw-play":
        return { name, command: name, args: ["--volume", String(volume), file] };
      case "aplay":
        return { name, command: name, args: ["-q", file] };
      case "powershell":
        return {
          name,
          command: "powershell.exe",
          args: ["-NoProfile", "-NonInteractive", "-Command", windowsMediaPlayer(file, volume)],
        };
    }
  };
  if (choice) return [command(choice)];
  if (platform === "darwin") return [command("afplay")];
  if (platform === "win32") return [command("powershell")];
  return [command("paplay"), command("pw-play"), command("aplay")];
}

/** Plays the file to its end, then exits (it's started again to loop, like the other players). */
function windowsMediaPlayer(file: string, volume: number): string {
  const quoted = `'${file.replace(/'/g, "''")}'`;
  return (
    `$p = New-Object -ComObject WMPlayer.OCX; $p.settings.volume = ${Math.round(volume * 100)}; ` +
    `$p.URL = ${quoted}; $p.controls.play(); Start-Sleep -Milliseconds 500; ` +
    // 3 is playing, 6 buffering, 9 opening; anything else (stopped, ended, failed) is the end.
    `while (@(3, 6, 9) -contains $p.playState) { Start-Sleep -Milliseconds 250 }`
  );
}

export interface MusicOptions {
  /** 0–1. */
  volume?: number;
  enabled?: boolean;
  /** Told once, when music can't play (no player, a file it can't read); after that it stays silent. */
  onError?: (err: Error) => void;
  platform?: NodeJS.Platform;
  choice?: PlayerName;
  /** For tests: what starts a command. */
  start?: (command: MusicCommand) => ChildProcess;
}

/**
 * Mood music: one track at a time, looped, alongside the voice. Told what should be playing after each
 * turn; the same track carries on, a different one replaces it, and none is silence.
 */
export class MusicPlayer {
  private track?: string;
  private child?: ChildProcess;
  /** Which of musicCommands() works here, once one has failed for not being installed. */
  private commandIndex = 0;
  private broken = false;
  /** Times in a row the track ended as soon as it started. */
  private quickEnds = 0;
  private on: boolean;
  private readonly volume: number;
  private readonly onError: (err: Error) => void;
  private readonly start: (command: MusicCommand) => ChildProcess;

  constructor(private readonly options: MusicOptions = {}) {
    this.on = options.enabled ?? true;
    this.volume = options.volume ?? 0.4;
    this.onError = options.onError ?? (() => {});
    this.start = options.start ?? ((c) => spawn(c.command, c.args, { stdio: "ignore", windowsHide: true }));
  }

  get enabled(): boolean {
    return this.on;
  }

  /** Plays `track` (an audio file), looped, unless it's already playing; undefined is silence. */
  play(track: string | undefined): void {
    if (track === this.track) return;
    this.halt();
    this.track = track;
    this.quickEnds = 0;
    this.loop();
  }

  /** Returns whether music is now on. Turning it back on resumes the current track from the start. */
  setEnabled(on: boolean): boolean {
    if (on === this.on) return on;
    this.on = on;
    if (on) this.loop();
    else this.halt();
    return on;
  }

  close(): void {
    this.halt();
    this.track = undefined;
  }

  private loop(): void {
    const track = this.track;
    if (!track || !this.on || this.broken) return;
    const commands = musicCommands(track, this.volume, this.options.platform, this.options.choice);
    const command = commands[Math.min(this.commandIndex, commands.length - 1)];
    const started = Date.now();
    const child = this.start(command);
    this.child = child;
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (err.code === "ENOENT" && this.commandIndex < commands.length - 1) {
        this.commandIndex++;
        return this.loop();
      }
      this.fail(err.code === "ENOENT" ? `${command.name} isn't installed` : err.message);
    });
    child.on("close", (code) => {
      // Stopped, or replaced by another track.
      if (this.child !== child) return;
      this.child = undefined;
      if (code !== 0) return this.fail(`${command.name} couldn't play ${track} (exit code ${code})`);
      this.quickEnds = Date.now() - started < SHORTEST_LOOP_MS ? this.quickEnds + 1 : 0;
      if (this.quickEnds >= QUICK_ENDS) return this.fail(`${track} ended as soon as it started, ${QUICK_ENDS} times`);
      this.loop();
    });
  }

  private halt(): void {
    const child = this.child;
    this.child = undefined;
    child?.kill();
  }

  private fail(message: string): void {
    if (this.broken) return;
    this.broken = true;
    this.onError(new Error(message));
  }
}
