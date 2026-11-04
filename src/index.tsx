#!/usr/bin/env node
// Composition root: the only place that picks concrete implementations.
import { render } from "ink";
import { loadConfig, type Config } from "./config.js";
import { CampaignLibrary } from "./game/campaigns.js";
import { MockProvider } from "./llm/mock.js";
import { OllamaProvider } from "./llm/ollama.js";
import type { LlmProvider } from "./llm/provider.js";
import { InMemoryStore } from "./storage/memory.js";
import { SqliteStore } from "./storage/sqlite.js";
import type { CampaignStore } from "./storage/store.js";
import { Root } from "./tui/root.js";
import { KokoroSpeaker } from "./voice/kokoro.js";
import { MusicPlayer } from "./voice/music.js";
import { systemPlayer } from "./voice/players.js";
import { VoiceOver } from "./voice/voice-over.js";

function createProvider(config: Config): LlmProvider {
  return config.llm === "mock"
    ? new MockProvider()
    : new OllamaProvider({ baseUrl: config.ollamaUrl, model: config.ollamaModel });
}

function createStore(config: Config): CampaignStore {
  return config.storage === "memory" ? new InMemoryStore() : new SqliteStore(config.sqliteFile);
}

async function main() {
  const config = loadConfig();
  const store = createStore(config);
  const llm = createProvider(config);
  // Load the model in the background while the player picks a campaign; errors surface on the first turn.
  void llm.warmUp?.().catch(() => {});
  const library = await CampaignLibrary.load(config.contentDir, store, llm);

  // Reading aloud: the speech model loads in the background too (or on /voice on, if it starts off). If it
  // can't work, the player is told once and it goes quiet. Each campaign brings its own voices (see Root).
  const speaker = new KokoroSpeaker({
    onError: (err) => voice.report(`Reading aloud is off: ${err.message}`),
    player: systemPlayer(process.platform, config.player),
  });
  const voice = new VoiceOver(speaker, { npcs: new Map() }, config.voice === "on");
  if (config.voice === "on") void speaker.warmUp().catch(() => {});
  const music = new MusicPlayer({
    volume: config.musicVolume,
    enabled: config.music === "on",
    onError: (err) => voice.report(`Music is off: ${err.message}`),
    choice: config.player,
  });

  const app = render(<Root library={library} voice={voice} music={music} />);
  await app.waitUntilExit();
  music.close();
  await speaker.close();
  await store.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
