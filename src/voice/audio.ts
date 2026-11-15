import type { Config } from "../config.js";
import { KokoroSpeaker } from "./kokoro.js";
import { MusicPlayer } from "./music.js";
import { systemPlayer } from "./players.js";
import { NO_CAST, VoiceOver } from "./voice-over.js";

export interface Audio {
  voice: VoiceOver;
  music: MusicPlayer;
  close(): Promise<void>;
}

/**
 * Reading aloud and mood music, through this system's audio players. The speech model loads in the
 * background (or on /voice on, if it starts off). If either can't work, the player is told once (through
 * voice.onNotice) and it goes quiet. Each campaign brings its own voices: see VoiceOver.use().
 */
export function createAudio(config: Pick<Config, "voice" | "player" | "music" | "musicVolume">): Audio {
  const speaker = new KokoroSpeaker({
    onError: (err) => voice.report(`Reading aloud is off: ${err.message}`),
    player: systemPlayer(process.platform, config.player),
  });
  const voice = new VoiceOver(speaker, NO_CAST, config.voice === "on");
  if (config.voice === "on") void speaker.warmUp().catch(() => {});
  const music = new MusicPlayer({
    volume: config.musicVolume,
    enabled: config.music === "on",
    onError: (err) => voice.report(`Music is off: ${err.message}`),
    choice: config.player,
  });
  return {
    voice,
    music,
    async close() {
      music.close();
      await speaker.close();
    },
  };
}
